import { supabase } from '../supabase';

export interface QueueContactInput {
  id?: string;
  contact_id?: string;
  email?: string | null;
  full_name?: string | null;
  name?: string | null;
  company?: string | null;
  designation?: string | null;
  industry?: string | null;
}

/**
 * Queues one or more contacts into the weekly_email_queue with status 'pending'
 * so they will automatically receive a welcome email on the scheduled Thursday run.
 * Dedupes against existing queue rows so an address is never queued twice.
 */
export async function queueContactsForWeeklyEmail(
  contacts: QueueContactInput[]
): Promise<{ added: number; skipped: number; error: string | null }> {
  try {
    const validInputs = contacts.filter(
      (c) =>
        c.email &&
        typeof c.email === 'string' &&
        c.email.trim().length > 0 &&
        c.email.includes('@') &&
        c.email.trim() !== '—' &&
        c.email.trim() !== '-'
    );

    if (validInputs.length === 0) {
      return { added: 0, skipped: 0, error: null };
    }

    // Fetch existing queued emails to dedupe
    const { data: existingRows, error: fetchErr } = await supabase
      .from('weekly_email_queue')
      .select('email');

    if (fetchErr) {
      console.warn('Could not fetch existing queue emails:', fetchErr.message);
    }

    const existingEmails = new Set(
      ((existingRows as { email: string | null }[] | null) ?? [])
        .map((r) => (r.email || '').toLowerCase().trim())
        .filter(Boolean)
    );

    const toInsert: any[] = [];
    const seenInBatch = new Set<string>();

    for (const c of validInputs) {
      const email = c.email!.trim();
      const lower = email.toLowerCase();
      if (existingEmails.has(lower) || seenInBatch.has(lower)) {
        continue;
      }
      seenInBatch.add(lower);

      toInsert.push({
        contact_id: c.contact_id || c.id || `contact-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        email,
        full_name: (c.full_name || c.name || '').trim(),
        company: (c.company || '').trim(),
        designation: (c.designation || '').trim(),
        industry: (c.industry || '').trim(),
        status: 'pending',
        queued_at: new Date().toISOString(),
      });
    }

    if (toInsert.length === 0) {
      return { added: 0, skipped: validInputs.length, error: null };
    }

    // Insert in batches of 50 to avoid payload limits
    let addedCount = 0;
    const CHUNK_SIZE = 50;
    for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
      const chunk = toInsert.slice(i, i + CHUNK_SIZE);
      const { error: insertErr } = await supabase
        .from('weekly_email_queue')
        .insert(chunk);

      if (insertErr) {
        // If batch fails (e.g. duplicate conflict), fall back to row-by-row
        console.warn('Batch queue insert failed, retrying per row:', insertErr.message);
        for (const row of chunk) {
          const { error: singleErr } = await supabase
            .from('weekly_email_queue')
            .insert(row);
          if (!singleErr) addedCount++;
        }
      } else {
        addedCount += chunk.length;
      }
    }

    return {
      added: addedCount,
      skipped: validInputs.length - addedCount,
      error: null,
    };
  } catch (err: any) {
    return {
      added: 0,
      skipped: contacts.length,
      error: err instanceof Error ? err.message : 'Failed to queue contacts for weekly email',
    };
  }
}

