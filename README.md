# Relationship Stat Tracker (RST)

---

# What's New

## Relationship-Relevance & No-Op Safety

Relationship updates now require persona-anchored evidence for each character, not merely scene-wide involvement. Direct interaction, grounded remote observation, surveillance, messaging, and concrete secondhand learning can qualify; NPC-only subplots, mere co-presence, reference-only mentions, and unrelated activity fail closed. Zero-change results are removed before review and rejected again at approval, while unchanged stats preserve their previously approved commentary instead of being rewritten by a no-op response.

## Hidden Deterministic Relationship Inertia

The continuity guard is now a completely hidden, deterministic per-stat hysteresis layer. It never appears in prompts, approval cards, ordinary UI, or exports. Same-direction movement is left to the stat-update model; inertia only resists large isolated reversals against trustworthy approved history. Reversal resistance releases as a new direction persists, and genuinely oscillating stats can become locally flexible without affecting unrelated relationship axes. Trusted history requires real scene/message provenance, excludes manual edits and implausible legacy jumps, and critical candidates retain their appropriate ordinary/critical range behavior. Diagnostics are available only through F12 debug logging.

## Persona Relationship Anchor

RST now treats the active persona as an immutable relationship subject. A prominent NPC, narrator viewpoint, or parallel subplot cannot replace the persona as the target of relationship-state generation. Blank/new profiles require actual evidence that the character interacted with, observed, learned about, or otherwise reacted to the persona before nonzero initial stats can be established.

## Milestone Assessment & Pagination

Every stat-update result must explicitly assess whether the scene produced a durable relationship milestone, returning either one qualifying milestone or an empty list. Ordinary warmth, first meetings, routine apologies, generic conflict, and isolated vulnerable lines do not qualify by themselves. Character Library milestone history is displayed newest-first in compact pages, with a default of five milestones per page and a configurable 1–50 page size. Stat-update context still receives only the three most recent milestones.

## Internal Relationship-Context Boundary

Relationship Milestones and Temporary Relationship Conditions remain available to RST's stat-update analysis, lifecycle/backfill tools, review flow, and Character Library, but they are intentionally excluded from the main roleplay prompt. This keeps internal relationship bookkeeping from directly steering the RP model or consuming unnecessary prompt context.

## Missed-Character Catch-Up Scan

Settings → Debug now includes a discovery-only catch-up scan for recently missed characters. The scan processes narrative history in configurable chunks, filters existing/blacklisted/player/reference-only/document-only names, preserves the normal live sidecar checkpoint and presence state, and uses the same Create / Ignore / dismiss semantics as live character discovery.

## Sidecar Reliability & Cadence Preservation

Presence scans can fire when either side of a message exchange crosses the configured cadence, failed/rejected scans remain due for retry, and destructive message edits invalidate stale in-flight results. Pausing the sidecar now freezes exact cadence progress: messages written while paused do not consume or restart the countdown, and the saved per-chat cadence resumes from the same point afterward.

## Explicit Settings Saves

Editable Settings sections now provide explicit Save buttons for Connection Profiles, Batch Scan, Scene Summary Prompt, Stat Settings, Detection Settings, and Injection Settings. These use SillyTavern's immediate settings persistence path so unblurred edits can be committed before a refresh. Existing lightweight autosave handlers remain as a convenience.

## Async & Chat-Scope Safety

Long-running scans, generation, review, and backfill operations are scoped to the chat that started them. Results produced after a chat switch or destructive message mutation are discarded instead of being written into stale or unrelated chat state.

## Deletion-Safe Sidecar Scheduling

The sidecar's message counter is now treated as the live chat message count at the last scan, rather than an ever-incrementing counter. If messages are deleted (for example, OOC messages cleaned out mid-chat) and SillyTavern renumbers the chat, RST detects the shrink, clears its session-only processed-message cache, and clamps the saved counter to the current chat length. The sidecar can no longer be stranded waiting for a message number that no longer exists. RST also now listens for message deletion, edit, and swipe events (when the running SillyTavern build provides them) and resets its runtime state defensively.

## Smarter Character Matching & Duplicate-Card Prevention

Stat-update parsing now resolves LLM-returned character names against canonical names, saved aliases, and fuzzy matches using one shared matcher, and tracks which LLM keys have already been consumed. A canonical name and one of its aliases can no longer produce two separate pending cards for the same character. As a final safety net, pending updates are deduplicated by character ID before saving and again when the Home tab renders, keeping the strongest entry (most stat changes, richest data) if duplicates ever slip through.

## Improved Initial Stat Generation

Initial generation now resolves aliases and fuzzy names into the existing zero-stat profile instead of creating a second "discovered" copy of the same character. When an LLM-returned name matches an existing character that is still all-zero, the entry is treated as true first-time initialization (no clamping by the Stat Change Range); if the character already has established stats, the normal delta-range, lock, and critical handling applies.

## Scene Close Responsiveness

Closing a scene now updates the UI immediately, before the stat-update LLM call begins, so a slow model no longer makes the scene look stuck open. Double-clicking the close button can no longer start overlapping stat-update calls. If generation runs long, a notice after 45 seconds confirms the scene is already closed and the LLM is simply still working, and the success toast reports how long generation took. If generation fails, the scene stays closed and the error message points to the console for the underlying LLM/API error.

## Relationship Milestones

RST can identify rare, durable turning points in a relationship alongside ordinary stat updates. Proposed milestones remain reviewable before they are saved, and existing milestones can be edited or deleted from the Character Library. A full-chat backfill option can scan an existing conversation for important milestones that predate the feature. Milestones are internal analysis/history state and are not directly injected into the main RP prompt.

## Temporary Relationship Conditions

Characters can carry temporary relationship states such as Guarded, Suspicious, Resentful, Protective, or Conflicted. Conditions can be proposed, updated, resolved, and historically backfilled as circumstances change. Unlike milestones, conditions represent the character's current relationship state rather than a permanent historical turning point. Their effects remain internal to RST's stat-update analysis instead of being injected directly into the main RP prompt.

## Relationship Trajectory & Inertia

RST derives visible relationship trajectory from approved stat history. Separately, its hidden deterministic inertia layer provides stat-local reversal hysteresis against abrupt unsupported direction changes without damping legitimate same-direction growth. The mechanism uses only trustworthy approved narrative history and remains absent from normal prompts, UI, review data, and exports.

## Expanded Sidecar Presence Tracking

The sidecar can now distinguish more than simple physical presence, including participation through calls, messaging, surveillance, remote involvement, and parallel-scene activity where applicable. Alias matching, scene-transition handling, response validation, and malformed-output safeguards were also strengthened so invalid sidecar output fails closed instead of wiping the current presence list.

The sidecar can also be paused and resumed directly from the extension UI.

## Live Sidecar Cadence Status

The Home tab now includes a compact sidecar status indicator showing whether presence detection is ready, paused, disabled, currently scanning, or due to run on the next user message. It also shows how many live chat messages remain before the next scheduled scan, making automatic presence detection easier to monitor without opening the settings panel.

## Synchronized Scene Status

The Home header and scene notices now refresh immediately when a scene is started, closed, or deleted from either message controls or the Scenes tab. The displayed open-scene status no longer remains stale until the panel is manually refreshed.

## Improved Approval Flow

Structural relationship changes such as milestones, conditions, and lock changes remain reviewable even when a scene produces no numeric stat changes. Approval cards and logs now expose more of the relevant relationship state before changes are committed.

## Settings & Storage Improvements

- Added clearer save feedback and improved persistence for the names blacklist.
- Added an explicit **Save Stat Settings** action.
- Added cleanup for obsolete stored evidence fields.

## Bug Fixes

- Fixed stale commentary in the prompt injection: the newest update-log entry is now read from the correct end of the log, so the injected commentary reflects the latest approved scene instead of the oldest.
- Fixed the remove (✕) button on "Currently present" character cards doing nothing when the click landed on the icon inside the button.
- Present-character cards now color their top stat values as positive/negative/neutral, matching the rest of the panel.
- Improved protection against duplicate first-time stat proposals for pre-created zero-stat profiles.
- Improved sidecar alias resolution and validation around scene changes.

---

# Implemented Relationship Systems

## Critical Increase/Decreases

Whenever a sufficiently significant moment occurs within the roleplay scene, the respective stat(s) can receive a critical increase or decrease beyond the normal amount set within the **Stat Change Range**. Critical changes are reserved for major relationship events and remain visible in the approval flow before being committed.

## Threshold Locks

### Hard Locks

This allows the AI to set caps or floors on an NPC's stats based on their personality, psychology, history, and established relationship behavior. If an NPC has strong reasons not to trust easily, for example, a Hard Lock can limit Trust until the relationship genuinely changes enough to justify movement beyond that boundary.

### Soft Locks (Unlockable)

This is a conditional cap or floor that may require the {{user}} to perform certain actions or meet specific narrative requirements before the respective stat can continue moving. The unlock condition is stored with the lock so relationship growth can resume naturally once the underlying obstacle has actually changed.

Threshold-lock backfilling can scan raw chat history in chunks and consider current stats, trajectory, milestones, conditions, existing locks, and historical behavior before proposing new locks. Existing lock slots are preserved instead of being overwritten unnecessarily.
