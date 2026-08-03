# Relationship Stat Tracker (RST)

---

# Features

## Deletion-Safe Sidecar Scheduling

The sidecar's message counter is now treated as the live chat message count at the last scan, rather than an ever-incrementing counter. If messages are deleted (for example, OOC messages cleaned out mid-chat) and SillyTavern renumbers the chat, RST detects the shrink, clears its session-only processed-message cache, and clamps the saved counter to the current chat length. The sidecar can no longer be stranded waiting for a message number that no longer exists. RST also now listens for message deletion, edit, and swipe events (when the running SillyTavern build provides them) and resets its runtime state defensively.

## Smarter Character Matching & Duplicate-Card Prevention

Stat-update parsing now resolves LLM-returned character names against canonical names, saved aliases, and fuzzy matches using one shared matcher, and tracks which LLM keys have already been consumed. A canonical name and one of its aliases can no longer produce two separate pending cards for the same character. As a final safety net, pending updates are deduplicated by character ID before saving and again when the Home tab renders, keeping the strongest entry (most stat changes, richest data) if duplicates ever slip through.

## Improved Initial Stat Generation

Initial generation now resolves aliases and fuzzy names into the existing zero-stat profile instead of creating a second "discovered" copy of the same character. When an LLM-returned name matches an existing character that is still all-zero, the entry is treated as true first-time initialization (no clamping by the Stat Change Range); if the character already has established stats, the normal delta-range, lock, and critical handling applies.

## Scene Close Responsiveness

Closing a scene updates the UI immediately, before the stat-update LLM call begins, so a slow model does not make the scene look stuck open. Double-clicking the close button cannot start overlapping stat-update calls. If generation runs long, a notice after 45 seconds confirms the scene is already closed and the LLM is still working, and the success toast reports how long generation took. If generation fails, the scene stays closed and the error message points to the console for the underlying LLM/API error.

The Home header and scene notices also refresh immediately when a scene is started, closed, or deleted from either message controls or the Scenes tab. Open-scene status therefore remains synchronized without requiring a manual panel refresh.

## Relationship Milestones

RST can now identify rare, durable turning points in a relationship alongside ordinary stat updates. Proposed milestones remain reviewable before they are saved, and existing milestones can be edited or deleted from the character library. A full-chat backfill option can also scan an existing conversation for important milestones that predate the feature.

## Temporary Relationship Conditions

Characters can now carry temporary relationship states such as Guarded, Suspicious, Resentful, Protective, or Conflicted. Conditions can be proposed, updated, or resolved as circumstances change. Unlike milestones, conditions represent the character's current relationship state rather than a permanent historical turning point.

## Relationship Trajectory & Inertia

RST now derives relationship trajectory from approved stat history and uses that history to discourage implausibly abrupt acceleration or reversals. Relationship inertia conservatively limits unsupported stat movement while still allowing sufficiently important critical moments to break through when appropriate.

## Expanded Sidecar Presence Tracking

The sidecar can distinguish more than simple physical presence, including participation through calls, messaging, surveillance, remote involvement, and parallel-scene activity where applicable. Alias matching, scene-transition handling, response validation, and malformed-output safeguards were also strengthened so invalid sidecar output fails closed instead of wiping the current presence list.

The sidecar can be paused and resumed directly from the extension UI. A compact Home-tab status indicator shows whether presence detection is ready, paused, disabled, currently scanning, or due to run on the next user message. It also displays how many live chat messages remain before the next scheduled scan.

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

# Relationship Systems

## Critical Increase/Decreases

Whenever a sufficiently significant moment occurs within the roleplay scene, the respective stat(s) can receive a critical increase or decrease beyond the normal amount set within the **Stat Change Range**. Critical changes are reserved for major relationship events and remain visible in the approval flow before being committed.

## Threshold Locks

### Hard Locks

This allows the AI to set caps or floors on an NPC's stats based on their personality, psychology, history, and established relationship behavior. If an NPC has strong reasons not to trust easily, for example, a Hard Lock can limit Trust until the relationship genuinely changes enough to justify movement beyond that boundary.

### Soft Locks (Unlockable)

This is a conditional cap or floor that may require the {{user}} to perform certain actions or meet specific narrative requirements before the respective stat can continue moving. The unlock condition is stored with the lock so relationship growth can resume naturally once the underlying obstacle has actually changed.

Threshold-lock backfilling can scan raw chat history in chunks and consider current stats, trajectory, milestones, conditions, existing locks, and historical behavior before proposing new locks. Existing lock slots are preserved instead of being overwritten unnecessarily.
