-- ============================================================================
-- Sequence per-step batching
-- ============================================================================
-- Adds CONTROLLED batch sending to sequences WITHOUT changing the existing
-- send behaviour: batch_enabled defaults to false, so every existing sequence
-- keeps sending all eligible recipients exactly as before.
--
-- DESIGN (Option A — one batch configuration inherited by every sequence step,
-- while the runtime still tracks INDEPENDENT batch progress PER STEP):
--
--   sequences.batch_enabled / batch_size / first_batch_delay_hours /
--   subsequent_batch_delay_hours  -> the shared, user-facing configuration.
--
--   sequence_step_batch_state (ONE ROW PER SEQUENCE STEP) -> the per-step
--   runtime queue. Every step owns its own batch counter, its own sent
--   accumulator and its own next_batch_at. Step 2 is never blocked by Step 1's
--   remaining batches and Step 2's schedule never controls Step 3's.
--
-- QUEUE MODEL (per step):
--   current_batch_number  -> which batch is currently open (1-based)
--   batch_sent            -> how many recipients already sent in this batch
--   next_batch_at         -> when the NEXT batch window opens
--   completed_at          -> set when every eligible send for the step is done
--
-- When an enrollment is due for a step, the sequence-runner checks the step's
-- state row:
--   * no state row / batch_enabled=false  -> send immediately (legacy path)
--   * batch open (batch_sent < batch_size) -> send + increment batch_sent
--   * batch full                          -> defer next_run_at to next_batch_at
--   * completed_at set                    -> defer to the runner's normal
--                                           re-check window
--
-- AGGREGATES (batch_size stored per step at creation):
--   createSequenceBatchState(seq, step, batchSize)  -> 1
--     creates the step's queue (or resets an existing one) atomically when the
--     sequence is activated / a step is added to a batched sequence.
--   incrementSequenceBatchCount(seq, step, batchSize, nextDelayHours)
--     -> {sent, batch_number, scheduled}
--     Atomically increments batch_sent; when the batch becomes full it rolls
--     into the NEXT batch (next_batch_at = now + nextDelayHours) and reports
--     scheduled=true so the caller defers the enrollment.
--     - First batch (current_batch_number=1) waits first_batch_delay_hours,
--       every later batch waits subsequent_batch_delay_hours. This is a
--       simplification of the campaign's first/subsequent delay split applied
--       to the per-step queue (the UI sends both delays as the single
--       configured interval).
--   completeSequenceBatchState(seq, step, eligibleCount)
--     -> {completed, current_batch_number, next_batch_at}
--     Marks the step's queue completed once every eligible recipient has been
--     sent (used when no more due enrollments remain).
--
-- DUPLICATE PROTECTION is unchanged (per step+contact): batch claiming here is
-- gated by the enrollment's atomic claim (next_run_at) and the single
-- sequence_step_logs row per (sequence, step, contact) — a recipient can never
-- receive the same step twice, regardless of scheduler retries.
-- ============================================================================

alter table if exists public.sequences
  add column if not exists batch_enabled boolean not null default false,
  add column if not exists batch_size integer not null default 30,
  add column if not exists first_batch_delay_hours double precision not null default 1,
  add column if not exists subsequent_batch_delay_hours double precision not null default 1;

-- Per-step runtime batch queue. One row per (sequence, step).
create table if not exists public.sequence_step_batch_state (
  sequence_id uuid not null,
  sequence_step_id uuid not null,
  batch_size integer not null default 30,
  batch_enabled boolean not null default true,
  first_batch_delay_hours double precision not null default 1,
  subsequent_batch_delay_hours double precision not null default 1,
  current_batch_number integer not null default 0,
  batch_sent integer not null default 0,
  next_batch_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint sequence_step_batch_state_pk primary key (sequence_id, sequence_step_id),
  constraint sequence_step_batch_state_step_fk
    foreign key (sequence_step_id) references public.sequence_steps(id) on delete cascade
);

create index if not exists sequence_step_batch_state_next_batch_at_idx
  on public.sequence_step_batch_state (next_batch_at);

-- ─── Helper: create / reset a step's batch queue ──────────────────────────
create or replace function public.create_sequence_batch_state(
  p_sequence_id uuid,
  p_sequence_step_id uuid,
  p_batch_size integer,
  p_batch_enabled boolean,
  p_first_delay double precision,
  p_subsequent_delay double precision
) returns integer
language plpgsql
as $$
begin
  insert into public.sequence_step_batch_state (
    sequence_id,
    sequence_step_id,
    batch_size,
    batch_enabled,
    first_batch_delay_hours,
    subsequent_batch_delay_hours,
    current_batch_number,
    batch_sent,
    next_batch_at,
    completed_at,
    updated_at
  ) values (
    p_sequence_id,
    p_sequence_step_id,
    greatest(1, coalesce(p_batch_size, 30)),
    coalesce(p_batch_enabled, true),
    greatest(0, coalesce(p_first_delay, 1)),
    greatest(0, coalesce(p_subsequent_delay, 1)),
    0,
    0,
    -- First-batch delay: when configured, arm next_batch_at so the runner's
    -- gate defers every enrollment until the first batch window opens. A zero
    -- delay opens batch 1 immediately (legacy-ish behaviour).
    case
      when coalesce(p_batch_enabled, true) and coalesce(p_first_delay, 1) > 0
      then now() + make_interval(secs => coalesce(p_first_delay, 1) * 3600)
      else null
    end,
    null,
    now()
  )
  on conflict (sequence_id, sequence_step_id) do update set
    batch_size = greatest(1, coalesce(p_batch_size, 30)),
    batch_enabled = coalesce(p_batch_enabled, true),
    first_batch_delay_hours = greatest(0, coalesce(p_first_delay, 1)),
    subsequent_batch_delay_hours = greatest(0, coalesce(p_subsequent_delay, 1)),
    -- Preserve in-flight progress (counting / window markers) on a pure
    -- config refresh — never silently reset a partially-sent queue.
    updated_at = now();
  return 1;
end;
$$;

-- ─── Helper: atomically record one send, rolling into the next batch ───────
create or replace function public.increment_sequence_batch_count(
  p_sequence_id uuid,
  p_sequence_step_id uuid,
  p_batch_size integer,
  p_next_delay_hours double precision
) returns table (
  sent integer,
  batch_number integer,
  next_batch_at timestamp with time zone,
  scheduled boolean
)
language plpgsql
as $$
declare
  v_state public.sequence_step_batch_state%rowtype;
  v_delay double precision;
  v_now timestamptz := now();
begin
  -- Lazily create the queue if it does not exist (defensive; the runner calls
  -- create_sequence_batch_state explicitly on activation / step creation).
  if not exists (
    select 1 from public.sequence_step_batch_state
    where sequence_id = p_sequence_id and sequence_step_id = p_sequence_step_id
  ) then
    insert into public.sequence_step_batch_state (
      sequence_id, sequence_step_id, batch_size, batch_enabled,
      first_batch_delay_hours, subsequent_batch_delay_hours,
      current_batch_number, batch_sent, updated_at
    ) values (
      p_sequence_id, p_sequence_step_id,
      greatest(1, coalesce(p_batch_size, 30)), true,
      coalesce(p_next_delay_hours, 1), coalesce(p_next_delay_hours, 1),
      0, 0, v_now
    );
  end if;

  select * into v_state
  from public.sequence_step_batch_state
  where sequence_id = p_sequence_id and sequence_step_id = p_sequence_step_id
  for update;

  if v_state.completed_at is not null then
    next_batch_at := null;
    scheduled := false;
    sent := v_state.batch_sent;
    batch_number := v_state.current_batch_number;
    return next;
  end if;

  if v_state.current_batch_number = 0 then
    -- First batch ever: opens immediately; the caller's already-processed
    -- enrollment is the first send (batch 1 count 1, no pending window).
    v_state.current_batch_number := 1;
    v_state.batch_sent := 1;
    v_state.next_batch_at := null;
    v_state.updated_at := v_now;
    update public.sequence_step_batch_state set
      current_batch_number = 1,
      batch_sent = 1,
      next_batch_at = null,
      completed_at = null,
      updated_at = v_now
    where sequence_id = p_sequence_id and sequence_step_id = p_sequence_step_id;
    next_batch_at := null;
    scheduled := false;
    sent := v_state.batch_sent;
    batch_number := v_state.current_batch_number;
    return next;
  end if;

  -- An existing batch: record one send. If a previous batch had rolled but its
  -- window is now open (next_batch_at in the past), the window marker is
  -- cleared so the UI shows in-progress instead of a stale "next batch" time.
  if v_state.next_batch_at is not null and v_state.next_batch_at <= v_now then
    v_state.next_batch_at := null;
  end if;
  v_state.batch_sent := v_state.batch_sent + 1;

  -- When the current window fills, roll into the NEXT batch: reset the count
  -- and physically schedule the next window (next_batch_at = now + delay). The
  -- caller sees scheduled=true and must defer further enrollments until that
  -- time — the cron keeps firing, but the destinations are not due again until
  -- next_batch_at, so a cloud schedule (never a browser/laptop timer) paces
  -- each step's batches.
  if v_state.batch_sent >= greatest(1, v_state.batch_size) then
    v_delay := coalesce(p_next_delay_hours, v_state.subsequent_batch_delay_hours);
    v_state.current_batch_number := v_state.current_batch_number + 1;
    v_state.batch_sent := 0;
    v_state.next_batch_at := v_now + make_interval(secs => greatest(0, v_delay) * 3600);
    v_state.updated_at := v_now;
    update public.sequence_step_batch_state set
      current_batch_number = v_state.current_batch_number,
      batch_sent = 0,
      next_batch_at = v_state.next_batch_at,
      updated_at = v_now
    where sequence_id = p_sequence_id and sequence_step_id = p_sequence_step_id;
    next_batch_at := v_state.next_batch_at;
    scheduled := true;
    sent := v_state.batch_sent;
    batch_number := v_state.current_batch_number;
    return next;
  end if;

  v_state.updated_at := v_now;
  update public.sequence_step_batch_state set
    batch_sent = v_state.batch_sent,
    next_batch_at = v_state.next_batch_at,
    completed_at = null,
    updated_at = v_now
  where sequence_id = p_sequence_id and sequence_step_id = p_sequence_step_id;
  next_batch_at := v_state.next_batch_at;
  scheduled := false;
  sent := v_state.batch_sent;
  batch_number := v_state.current_batch_number;
  return next;
end;
$$;

-- ─── Helper: mark a step's queue completed (all eligible sends delivered) ──
create or replace function public.complete_sequence_batch_state(
  p_sequence_id uuid,
  p_sequence_step_id uuid
) returns table (
  completed_at timestamp with time zone,
  current_batch_number integer,
  next_batch_at timestamp with time zone
)
language plpgsql
as $$
begin
  if not exists (
    select 1 from public.sequence_step_batch_state
    where sequence_id = p_sequence_id and sequence_step_id = p_sequence_step_id
  ) then
    return;
  end if;
  update public.sequence_step_batch_state set
    completed_at = now(),
    next_batch_at = null,
    updated_at = now()
  where sequence_id = p_sequence_id and sequence_step_id = p_sequence_step_id
  returning completed_at, current_batch_number, next_batch_at
  into completed_at, current_batch_number, next_batch_at;
  return next;
end;
$$;