# Relationship Stat Tracker (RST)

Relationship Stat Tracker is a SillyTavern extension for tracking how individual characters feel about the user over time. It maintains configurable relationship stats, scene-aware updates, approval workflows, threshold locks, relationship history, and contextual relationship state while keeping the final changes under user control.

---

# What's New

## Relationship Milestones

RST can now identify rare, durable turning points in a relationship alongside ordinary stat updates. Proposed milestones are shown for review before being saved and can be edited or deleted later from the character's relationship history.

A full-chat backfill option is also available for generating milestones from existing conversations.

## Temporary Relationship Conditions

Characters can now carry temporary contextual relationship states such as **Guarded**, **Suspicious**, **Resentful**, **Protective**, or **Conflicted**. Conditions can be proposed, updated, or resolved as the relationship changes and are included in the approval flow and character library.

Unlike milestones, conditions describe the character's current relationship state rather than a permanent turning point.

## Relationship Trajectory & Inertia

RST now derives a relationship trajectory from approved stat history and uses that history to keep future changes psychologically consistent.

Relationship inertia applies conservative limits when a proposed update would accelerate a stat too quickly or reverse an established trend without enough justification. Genuine critical moments can still bypass normal inertia when appropriate.

## Critical Stat Changes

Major relationship events can trigger critical increases or decreases beyond the normal configured Stat Change Range. Critical changes are reserved for sufficiently significant events rather than ordinary scene movement and remain visible in the approval flow before being committed.

## Threshold Locks

### Hard Locks

Hard Locks allow specific stats to be capped or floored based on a character's personality, psychology, history, and established relationship behavior.

### Soft Locks

Soft Locks are conditional limits that can prevent further movement in a stat until an appropriate narrative requirement is met. The required condition is stored with the lock so the relationship can progress naturally once the underlying obstacle has actually changed.

Threshold-lock backfilling now examines raw chat history in chunks and considers existing stats, relationship trajectory, milestones, conditions, locks, and historical behavior before proposing new locks. Existing lock slots are preserved rather than overwritten unnecessarily.

## Sidecar Presence Tracking Overhaul

The sidecar now handles character presence with more context than a simple present/absent flag. It can distinguish participation through physical presence, calls, messaging, surveillance, remote involvement, and parallel-scene activity where applicable.

Additional safeguards improve alias matching, scene-transition handling, evidence validation, and malformed-response handling. Invalid sidecar output now fails closed instead of wiping the current presence list.

The sidecar can also be paused and resumed directly from the extension UI.

## Deletion-Safe Sidecar Scheduling

The sidecar's message counter is treated as the live chat message count at the last scan rather than an ever-incrementing counter. If messages are deleted and SillyTavern renumbers the chat, RST detects the shrink, clears its session-only processed-message cache, and clamps the saved counter to the current chat length.

RST also listens for supported message deletion, edit, and swipe events and resets its runtime state defensively.

## Smarter Character Matching & Duplicate-Card Prevention

Stat-update parsing resolves returned character names against canonical names, saved aliases, and fuzzy matches using a shared matcher. Canonical names and aliases can no longer create duplicate pending cards for the same character.

Pending updates are also deduplicated before saving and when the Home tab renders, keeping the strongest available entry if duplicates ever slip through.

## Improved Initial Stat Generation

Initial generation now resolves aliases and fuzzy names into an existing zero-stat profile instead of creating a second discovered copy of the same character.

When a returned name matches an existing all-zero character, the entry is treated as true first-time initialization and is not clamped by the normal Stat Change Range. Established profiles continue to use normal delta-range, lock, inertia, and critical-change handling.

## Improved Approval Flow

Structural relationship changes such as milestones, conditions, and lock changes remain reviewable even when a scene produces no numeric stat changes.

Approval cards and logs now expose more of the reasoning-relevant relationship state, including inertia, milestones, and conditions, before changes are committed.

## Scene Close Responsiveness

Closing a scene updates the UI immediately before the stat-update LLM call begins, so a slow model no longer makes the scene appear stuck open. Repeated clicks cannot start overlapping close/update requests.

If generation takes unusually long, RST confirms that the scene itself is already closed while generation continues. Failed generation does not reopen the scene.

## Settings & Storage Improvements

- Added clearer save feedback for the names blacklist and improved blacklist persistence.
- Added an explicit **Save Stat Settings** action.
- Added cleanup for obsolete stored evidence fields.
- Present-character cards use positive, negative, and neutral stat coloring consistently with the character library.

## Additional Fixes

- Fixed stale commentary in prompt injection so the newest approved update-log entry is used.
- Fixed the remove button on **Currently Present** character cards when clicking directly on its icon.
- Improved sidecar alias resolution and validation around scene changes.
- Improved protection against duplicate first-time stat proposals for pre-created zero-stat profiles.
