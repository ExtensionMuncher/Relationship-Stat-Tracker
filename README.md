# Relationship Stat Tracker (RST)

A per-chat relationship continuity extension for [SillyTavern](https://github.com/SillyTavern/SillyTavern). RST tracks how individual characters relate to the active persona over time, keeps those changes reviewable before they become canonical, and gives long-running roleplay a persistent relationship state without forcing the roleplay model to maintain a giant hand-written relationship ledger.

RST is designed for multi-character and long-form roleplay where relationships should change gradually, unevenly, and according to what actually happened in the story. It tracks relationship statistics, commentary, scenes, presence, milestones, temporary relationship conditions, hard and soft locks, and approved update history on a per-chat basis.

---

## Requirements

- A recent SillyTavern installation.
- SillyTavern's **Connection Manager** enabled and at least one usable Connection Profile.
- A model/profile for relationship analysis. The same profile can be reused for all RST roles, or different profiles can be assigned for quality, latency, and cost.

RST stores relationship data inside the current chat's metadata. Character profiles and relationship state from one chat do not automatically carry into another chat.

---

## Installation

1. Place the `Relationship-Stat-Tracker` folder in:
   `SillyTavern/public/scripts/extensions/third-party/Relationship-Stat-Tracker`
2. Reload SillyTavern. A hard refresh is recommended after replacing extension files.
3. Open **Relationship Stat Tracker** from the Extensions panel.

To update RST, replace the extension folder with the new version and reload SillyTavern. Existing per-chat relationship data is migrated forward when possible.

---

## First-Time Setup

Open the **Settings** tab and configure the three Connection Profiles:

- **Stat update LLM** — analyzes completed scenes and proposes relationship changes. This is the most important role and should use the strongest model of the three when possible.
- **Sidecar detection LLM** — tracks which known characters are currently relevant/present and detects unknown characters. A smaller, fast model is usually sufficient.
- **Auto-gen profile LLM** — generates initial character profile information when you create a newly detected character.

RST supports per-profile **No-think** controls for compatible models. These can be configured independently for the assigned Connection Profiles.

The default stat-change range is conservative (`-5` to `+5` per scene), and RST is intentionally biased toward **no change unless the scene contains relationship evidence**.

---

## How to Use RST

### 1. Track a scene

Use the RST scene controls on SillyTavern message bars to mark the beginning and end of a scene.

When a scene closes:

1. The scene closes immediately in the UI.
2. RST generates an internal scene summary.
3. Characters relevant to the persona relationship are evaluated.
4. Proposed relationship changes are sent to **Home → Pending updates**.
5. Nothing becomes canonical until you approve it.

If the LLM call is slow, the scene remains closed while generation continues. Closing the same scene repeatedly will not intentionally start overlapping update calls.

### 2. Review pending changes

The **Home** tab is the review surface for newly generated relationship state.

Pending cards can include:

- Numeric stat changes
- Relationship commentary
- Dynamic relationship title changes
- Relationship milestones
- Temporary relationship conditions
- Hard-lock changes and pressure
- Soft-lock changes and progress
- Critical cap changes

The scene summary has its own approval lifecycle, separate from character stat approval.

You may approve or dismiss cards individually, or use **Approve all / Dismiss all**. Zero-change/no-op updates are filtered before review and rejected again at approval so invisible no-op entries cannot create update history.

### 3. Keep an eye on presence

The Home tab also shows **Currently present** characters and the live Sidecar cadence status.

Presence is broader than simple physical co-location. RST can recognize narratively relevant participation through:

- Physical presence
- Live remote interaction
- Messaging
- Surveillance/observation
- Relevant parallel-scene involvement

Simple mentions, historical references, hypothetical discussion, reference documents, or unrelated NPC-only activity should not count as active relationship presence.

### 4. Maintain the Character Library

The **Library** tab contains the canonical relationship profiles for the current chat. You can inspect and edit character information, aliases, relationship stats, commentary, locks, milestones, conditions, and update history.

### 5. Use Scenes for history and corrections

The **Scenes** tab lists open and closed scenes. Scene titles, participants, and summaries can be edited. Closed scenes can be retried for stat analysis when no other review is pending.

---

## Relationship Matrix

Each tracked character has up to three relationship categories:

- **Platonic**
- **Romantic**
- **Sexual**

Each category contains four relationship stats:

- **Trust**
- **Openness**
- **Support**
- **Affection**

Stats are stored on a `-100` to `100` scale.

Individual relationship categories can be hidden on a per-character basis. A hidden category is not merely cosmetic: it is excluded from prompt injection and from RST's internal LLM analysis/modification for that profile.

### No Change by Default

RST does not assume that every scene changes every relationship.

- Stagnation is not regression.
- A character being present does not require a stat update.
- A positive scene does not automatically raise all positive stats.
- Stat decreases require negative relationship evidence.
- NPC-only developments do not change a character's relationship with the persona unless that character actually gains relevant knowledge or is involved in a persona-related interaction.

Unchanged stats keep their last approved commentary instead of receiving rewritten filler commentary.

---

## Persona-Anchored Relationship Evidence

RST treats the active SillyTavern persona as the fixed subject of its relationship tracking.

A character update must be grounded in evidence about **that character's relationship to the persona**. A prominent NPC, narrator viewpoint, or parallel subplot cannot silently replace the persona as the relationship subject.

A character may still be relationship-relevant without physically sharing a room with the persona. Remote interaction, surveillance, messaging, or credible secondhand knowledge can qualify when the narrative supports it.

For new/blank profiles, RST requires evidence that the character interacted with, observed, learned something meaningful about, or otherwise reacted to the persona before assigning nonzero initial relationship stats.

---

## Critical Changes

Critical changes allow unusually important relationship moments to exceed the normal **Stat Change Range**.

The stat-update model first has to identify a change as significant enough to qualify. RST then applies the configured critical chance. Critical changes are intentionally rare and remain visible in the approval flow before becoming canonical.

The critical multiplier determines the larger range available to a successful critical change.

---

## Relationship Trajectory & Hidden Inertia

RST derives visible relationship trajectory from approved relationship history.

Separately, RST uses a **hidden deterministic inertia layer** to prevent implausible one-scene reversals in established stats. Inertia is not another model output and is not shown in normal UI, prompts, approval cards, or exports.

The current inertia system behaves as per-stat reversal hysteresis:

- Same-direction growth or decline is not damped by inertia.
- A large isolated reversal against trustworthy approved history may be resisted.
- Resistance releases when the new direction persists across grounded updates.
- Repeated genuine oscillation can make that individual stat more flexible without affecting unrelated stats.
- Manual edits and unreliable/legacy transitions are excluded from trusted inertia history.

When Debug F12 logging is enabled, diagnostic information can be inspected in the browser console without exposing inertia to the stat-update model.

---

## Hard Locks

Hard Locks are psychological ceilings/floors applied to individual relationship stats.

They are intended for characters whose established personality or history makes certain relationship movement implausible without a major change. For example, a character who fundamentally distrusts others may have a Trust cap until enough contradictory evidence accumulates.

Hard Locks require the character's **Personality** field to contain usable information. RST will not invent psychology-based locks for an empty personality profile. This eligibility is enforced after model parsing as well as in the prompt, so a newly discovered character whose profile did not exist when generation began cannot accidentally surface a lock from the discovery scene before Personality is filled.

### Hard-Lock Pressure

A hard lock can accumulate **pressure** when the narrative repeatedly provides evidence against the reason that lock exists.

Pressure does not directly raise the stat. Instead, reaching the maximum flags the lock for user review and allows RST to recommend whether the cap itself should change.

This keeps hard locks durable without making them permanently immune to genuine character development.

---

## Soft Locks

Soft Locks are conditional relationship caps tied to a narrative requirement.

A soft lock contains:

- A stat cap
- An unlock condition
- Progress notes
- Whether the condition has been met

When the condition is fulfilled, the lock can release and normal stat movement resumes. Unlike a Hard Lock, a Soft Lock is not meant to be broken simply by a critical change.

The maximum number of simultaneous active Soft Locks per character is configurable from **1–3**. This is a ceiling, not a target; RST may use fewer or none.

Soft Locks also require a usable Personality field so the system has enough character context to justify them.

---

## Relationship Milestones

Milestones are rare, durable turning points in the relationship rather than ordinary scene beats.

Every stat update explicitly assesses whether a qualifying milestone occurred and returns either a real proposal or no milestone. Routine friendliness, first meetings, minor apologies, generic arguments, or isolated emotional lines should not become permanent milestones by default.

Milestones:

- Are reviewable before commit
- Can be edited or deleted from the Character Library
- Can be backfilled from older chat history
- Are shown newest-first in paginated Library history
- Use a configurable page size from **1–50** (default: 5)
- Supply only the **three most recent milestones** to stat-update analysis

Milestones are **internal relationship-analysis/history state**. They are not directly injected into the main roleplay prompt.

---

## Temporary Relationship Conditions

Temporary Relationship Conditions describe a character's current relationship state when that state matters to how new evidence should be interpreted.

Examples include states such as Guarded, Suspicious, Resentful, Protective, or Conflicted.

Conditions can be proposed, approved, updated, resolved, and historically backfilled. Unlike Milestones, they are not permanent turning points; they describe a temporary relationship condition that may later disappear.

Temporary Conditions are internal to RST's stat-update analysis and are intentionally excluded from the main roleplay prompt.

---

## Character Presence & Discovery

The Sidecar runs on a configurable cadence and reconciles which known characters are relevant to the current narrative window.

Verified top-level scene boundaries also reconcile cast changes locally: physical, unknown, and parallel-scene presence from the prior scene is retired when the story clearly cuts to a new location/time, even if the model omits an explicit reset. Live calls and surveillance can persist across a physical camera cut until the narrative separately ends them. Long-form location/time headers and travel-compression transitions are recognized as boundary evidence.

### Cadence

- **Scan frequency** controls how many narrative messages pass between presence scans.
- **Messages to scan** controls how much recent story context the Sidecar reads.
- The Home tab shows the live cadence state and how many messages remain before the next scan.
- Pausing the Sidecar freezes its exact cadence position. Messages written while paused do not consume or reset progress.
- Failed/rejected scans remain due for retry instead of silently consuming the checkpoint.

### New characters

When **New character popup** is enabled, an unknown grounded character can be offered for creation. The popup actions are explicit:

- **Create** — creates the profile.
- **Ignore** — adds the name to the blacklist.
- Closing/dismissing the popup — does neither.

The per-chat **Name blacklist** can also be edited manually. The active SillyTavern persona name is excluded from character detection automatically.

Automatic discovery resolves detected names through the same canonical identity boundary before creating anything. Exact names, saved aliases, reversed full-name order, and unique complete-token shortened names reuse the existing profile. Ambiguous known identities fail closed instead of creating a duplicate. Older blank auto-generated duplicates can be cleaned up conservatively during migration when exactly one richer canonical equivalent exists; profiles with meaningful stats, history, or authored content are never auto-merged or auto-deleted.

### Missed-character catch-up

**Settings → Debug → Scan for Missed Characters** performs a discovery-only historical pass over recent narrative messages. It proposes unknown grounded characters without changing normal Sidecar cadence or current presence state.

---

## Character Library

The Library is the main place to inspect and maintain established character profiles.

A profile can contain:

- Name and aliases
- Description, Personality, and Notes
- Relationship matrix
- Per-category visibility
- Current relationship commentary and dynamic title
- Hard Locks and pressure
- Soft Locks and progress
- Relationship Milestones
- Temporary Relationship Conditions
- Recent approved update history

Name matching uses canonicalized identity and aliases to reduce duplicate profiles caused by punctuation, Unicode differences, alternate word order, or common shortened names.

### Update history and rollback

Approved relationship updates retain enough prior relationship state to support guarded rollback. Rollback refuses to overwrite newer manual edits when the stored post-update state no longer matches the current profile.

---

## Scenes

RST scenes provide the evidence window used for relationship analysis.

The Scenes tab supports:

- Open and closed scene history
- Scene titles
- Character/participant editing
- Scene summary editing and saving
- Retrying stat review for a closed scene
- Deleting scenes
- Bulk selection/deletion of closed scenes

Deleting an open scene does not generate a summary or relationship update. Deleting or editing messages/scenes also invalidates stale Sidecar work so old asynchronous results cannot commit against changed story evidence.

During stat-update preparation, an existing profile is added to a scene roster only when the reviewed scene locally grounds active physical, remote, surveillance, messaging, or relevant parallel involvement. Broad historical rosters are rebuilt from that evidence rather than trusted blindly. Scene-roster enrichment is transactional: it commits only after every required stat response parses successfully, so malformed or truncated output cannot leave the scene polluted with characters that were never successfully reviewed.

---

## Batch Scan

**Settings → Batch Scan** can retrofit RST onto an existing chat.

Batch Scan detects historical scene ranges, creates missing profiles when justified, generates summaries, and processes relationship state in chronological order.

Important safeguards:

- Scene-detected character names are advisory, not automatically trusted.
- Proposed characters are grounded against the actual narrative messages in the detected scene.
- Reference-only/document-only names are rejected.
- Existing profiles and aliases are reused where possible.
- Established characters use the same constrained update pipeline as normal live scenes; their existing stats are not treated as fresh initialization.
- Historical initial stats still require persona-anchored relationship evidence.

Batch Scan settings include token limits, request rate limiting, retry behavior, optional delays, and range combining for compatible context windows.

---

## Backfill & Repair Tools

Settings → Debug includes historical maintenance tools for relationship systems that may have been introduced after a chat began.

### Relationship Milestone Backfill

Scans visible chat history for durable relationship turning points. Proposals are reviewed before becoming permanent history and do not modify relationship stats.

### Temporary Condition Backfill

Scans historical relationship context for conditions that should still matter or for historical state needed to make current relationship analysis coherent. Results are reviewed before application.

### Threshold Lock Backfill

Uses chat history together with current stats, trajectory, milestones, conditions, summaries, personality, and existing lock state to propose missing Hard/Soft Locks. Existing occupied lock slots are preserved.

### Missed Character Scan

Performs discovery-only scanning for grounded NPCs that may have appeared before the current Sidecar checkpoint.

---

## Settings Reference

### Connection Profiles

- **Stat update LLM** — scene relationship analysis and proposals.
- **Sidecar detection LLM** — presence reconciliation and unknown-character detection.
- **Auto-gen profile LLM** — initial generated character profile data.
- **No-think per profile** — optional reasoning suppression for compatible backends.

Use **Save Connection Profiles** to commit the section immediately.

### Batch Scan

Controls:

- Scene detection max tokens
- Initial stat max tokens
- Requests per minute
- Max retries
- Base retry delay
- Per-scene delay
- Inter-phase delay
- Combine ranges in a single call

### Scene Summary Prompt

Customizes the internal prompt used to summarize completed scenes for future relationship analysis.

### Stat Settings

Controls:

- Normal Stat Change Range
- Critical Changes on/off
- Critical chance
- Hard Locks on/off
- Soft Locks on/off
- Maximum active Soft Locks per character

### Detection Settings

Controls:

- Sidecar Scan frequency
- Messages to scan
- New character popup
- Name blacklist

### Injection Settings

Controls what relationship information reaches the main roleplay model.

Options include:

- Inject stat block
- Inject character profile
- Injection format
- Injection placement
- Passive Library Reference
- Stat lookup tool/function calling
- Library-reference depth and speaker role

Milestones, Temporary Relationship Conditions, and hidden inertia data are intentionally not directly included in the normal RP prompt.

### Data

- **Milestones per page** — 1–50, default 5.
- **Import all** — restores RST settings and chat data from an export.
- **Export all** — downloads a full backup of RST settings and current-chat relationship data.

### Debug

Includes F12 logging and historical backfill/repair tools. Debug logging is off by default; warnings and errors remain visible regardless.

---

## Prompt Injection & Lookup

RST can inject the relationship information for currently relevant characters into the main roleplay context.

You can configure whether to inject:

- Stat blocks
- Character profile text
- Both stats and narrative relationship context

**Passive Library Reference** can make broader tracked relationship data available as reference context when enabled.

When the backend supports tool calling, RST can also register a stat lookup tool so the main model can request a tracked character's relationship data on demand, even if that character is not currently present.

Internal analysis systems such as Milestones, Temporary Relationship Conditions, and hidden deterministic inertia remain separated from the normal roleplay prompt.

---

## Import, Export & Backups

RST data is stored per chat. Use **Settings → Data → Export all** to create a JSON backup containing settings, character profiles, and current-chat RST metadata.

Imports support current exports as well as older backup layouts where possible. Migration fills in newer fields while preserving existing relationship profiles, scenes, presence state, aliases, and configured connections.

Regular exports are recommended for long-running roleplays.

---

## Reliability & Safety Notes

RST is deliberately conservative about relationship state:

- No change is preferred over inventing movement.
- Relationship decreases need negative evidence.
- New relationships need persona-relevant evidence.
- Hidden continuity safeguards do not become LLM instructions.
- Generated state is reviewable before commit.
- Long-running asynchronous work is scoped to the chat that started it.
- Results produced after a chat switch or destructive message mutation are discarded rather than written into stale state.
- Legacy internal-only evidence/diagnostic fields are scrubbed during migration and are not part of normal exports.
- Automatic character creation reuses canonical identities and fails closed on ambiguity instead of manufacturing duplicate profiles.
- Scene-roster enrichment commits transactionally only after the required stat responses parse successfully.

These constraints are intended to make RST useful over hundreds or thousands of messages without letting incidental scene activity slowly distort the relationship model.

---

## Troubleshooting

### No pending relationship update appears after closing a scene

This can be correct. RST intentionally produces no relationship update when the scene contains no meaningful persona-anchored relationship change. Check F12 for generation errors if you expected an update.

### A character is not detected as present

Check:

- The Sidecar Connection Profile is configured and available.
- The Sidecar is not paused.
- Detection cadence is due.
- The character is not blacklisted.
- The recent message window actually contains grounded participation rather than only a reference.

For older missed appearances, use **Debug → Scan for Missed Characters**.

### A character keeps appearing twice

Add/repair aliases in the Character Library and make sure the duplicate names really refer to the same person. RST performs canonical name matching, but ambiguous unrelated short names are intentionally not collapsed blindly.

### A stat refuses to rise

Inspect the character's Hard/Soft Locks. A Hard Lock may cap normal growth; a Soft Lock may require its stated narrative condition to be fulfilled before progression resumes.

### A stat reversal seems smaller than expected

For established history, hidden deterministic inertia may be resisting a large isolated reversal. Enable Debug F12 logging if you need to inspect the calculation. Inertia does not affect same-direction movement and releases when the new direction becomes sustained evidence.

### Batch Scan produces no new profile for a mentioned character

Batch Scan intentionally rejects reference-only names. The character must be grounded as an active participant, remote participant, observer, messenger, or otherwise persona-relevant actor within the scanned narrative evidence.

---

## Notes

- RST is a relationship-continuity aid, not a replacement for the character card or the roleplay model's judgment.
- Generated changes are proposals until approved.
- Stronger models generally improve nuanced stat/commentary decisions; the Sidecar role can usually use a smaller, faster model.
- Per-chat storage means deleting a chat also deletes that chat's RST metadata unless you exported it first.

---

*Relationship Stat Tracker is a community SillyTavern extension. It orchestrates models you configure through SillyTavern's Connection Manager and ships no model of its own.*
