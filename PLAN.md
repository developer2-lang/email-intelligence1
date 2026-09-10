# Plan: Remove "Not Opened" from Original Campaign Dropdown

## Summary
Remove all "not opened" options, counts, and related UI from the Original Campaign dropdown in the Follow-ups → Composer & Editor page. Keep all existing "opened" functionality, sending, batching, and pipeline untouched.

## File: `src/pages/FollowupsTab.tsx`

### 1. Remove `fetchNotOpenedCounts` import (line 30)
Delete `fetchNotOpenedCounts,` from the followupService import block. No longer needed.

### 2. Remove `notOpenedCounts` state (lines 226–229)
Delete the state declaration and its 3-line comment. This state is ONLY used for the dropdown's "not opened" counts.

### 3. Remove `notOpenedCounts` useEffect (lines 457–469)
Delete the entire effect that calls `fetchNotOpenedCounts`. This is ONLY for populating the dropdown's "not opened" counts.

### 4. Simplify the `<select>` value prop (lines 1650–1654)
Change from encoding `${originalId}:${followupAudience}` to just `originalId`. Since audience is always 'opened' now, no need for compound values.

### 5. Simplify the `onChange` handler (lines 1655–1664)
Remove the `val.split(':')` logic. Just `setOriginalId(val)` directly since we no longer encode audience in the dropdown value.

### 6. Remove `notOpened` variable and `not_opened` option from dropdown (lines 1675, 1681–1683)
- Delete `const notOpened = String(notOpenedCounts[cid] ?? 0)`
- Delete the `<option value={\`${cid}:not_opened\`}>` block
- Remove `<Fragment>` wrapper (only one `<option>` per campaign now)
- Also remove `Fragment` from the React import (line 1)

### 7. Replace "Follow-up Audience" radio buttons with static indicator (lines 1801–1821)
Replace the radio group (which had both 'opened' and 'not_opened' options) with a single static display showing "Opened recipients" with its hint. No interactive radio needed since there's only one option.

### 8. Update info/batch estimate text (lines 1840–1886)
Remove all `followupAudience === 'not_opened'` ternary branches. Keep only the 'opened' text paths:
- Line 1843: Change `{followupAudience === 'not_opened' ? 'non-opened' : 'opened'}` → `'opened'`
- Lines 1857–1859: Change the ternary → just `'Opened recipients'`
- Lines 1863–1865: Change the ternary → just `audienceCounts.opened`
- Lines 1881–1883: Change the ternary → just `'opened'`

### 9. Simplify batch size eligible count calculations
- Lines 720–725: Remove the `followupAudience === 'not_opened'` branch, use only `audienceCounts?.opened`
- Lines 2113–2118: Same simplification

### 10. Update creation success messages (lines 791, 794)
Remove `followupAudience === 'not_opened'` ternaries:
- Line 791: Change to always say 'openers'
- Line 794: Change to always say 'openers only.'

### 11. Update helper text (lines 1905–1907)
Remove reference to "Not opened recipients" delivery. Keep only the opened recipients explanation.

## What is NOT changed
- `followupAudience` state declaration (line 224) — still needed, always 'opened'
- `audienceCounts` state (line 225) — still needed for batch size validation
- `fetchAudienceCounts` call (line 449) — still needed for `audienceCounts`
- `loadAllOpened` — still needed for "All" campaign support
- `createFollowupConfig` call — unchanged, `audience: followupAudience` still works
- `FollowupAudience` type import — still needed (used in state type)
- Database schema — untouched
- ActivityModal — untouched
- Backend services — untouched
- Follow-up sending/batching/scheduling pipeline — untouched
