# Relationship Stat Tracker (RST)

A SillyTavern extension that tracks relationship stats between characters across roleplay sessions. RST uses a lightweight sidecar LLM to detect which characters are currently involved in the narrative, and a main stat-update LLM to review closed scenes and generate nuanced relationship changes — all without interrupting your primary AI or requiring the main model to manually maintain the entire relationship state itself.

> **Status: Alpha** — Core systems are functional. Some features are still being stabilized. Expect rough edges. Back up your SillyTavern data before use.

---

## Features

- **Automatic character presence detection** via a configurable sidecar LLM, with support for physical presence, calls, messages, surveillance, other live remote involvement, and active parallel POV scenes
- **Pause / Resume Sidecar controls** on the Home tab, plus a live cadence indicator showing when the next scan is due
- **Deletion-safe sidecar scheduling** so deleting, editing, or swiping messages does not strand the scan counter on a message index that no longer exists
- **Per-chat name blacklist** for names that should never be treated as tracked characters; the active ST user persona is excluded automatically
- **12-stat relationship matrix** per character — three fixed categories (Platonic, Romantic, Sexual), each with four stats (Trust, Openness, Support, Affection) — all expressed as percentages that can go negative
- **Per-profile visibility controls** for Personality, Notes, and individual Platonic/Romantic/Sexual stat categories so unwanted fields can be hidden from prompts and LLM updates
- **Scene management** with Scene Start and Scene End buttons added directly to your chat messages
- **Stat updates on scene close** — the stat-update LLM reviews what happened in the scene and proposes before→after changes, per-stat commentary, narrative state, milestones, conditions, and lock changes when appropriate
- **User approval flow** — proposed changes are held in a Pending Updates section on the Home tab and are never committed until you approve them
- **Critical stat changes** — pivotal, LLM-flagged relationship moments can pass a configurable RNG check and receive a larger movement ceiling than ordinary scenes
- **Hard threshold locks** — optional personality/history-based caps that prevent ordinary growth past a psychologically appropriate ceiling
- **Hard-lock pressure and review** — sustained evidence against an existing hard lock can build pressure and eventually produce a user-reviewed recommendation to maintain, raise, soften, or remove the cap
- **Soft threshold locks** — optional conditional caps that remain active until their narrative requirement is met, then unlock automatically
- **Relationship Trajectory** — a deterministic, read-only trend derived from approved stat history; no additional LLM call is required
- **Relationship Milestones** — durable turning points that preserve important relationship developments separately from raw stat values
- **Temporary Relationship Conditions** — short-term contextual states such as Guarded, Suspicious, Protective, Conflicted, Jealous, Vulnerable, Post-Rupture Repair, and more; conditions influence interpretation without becoming permanent personality traits or stat bonuses
- **Relationship inertia** — conservative history-based damping that resists unjustified acceleration or abrupt reversals while never boosting a proposed change; fired criticals bypass inertia
- **Scene summaries as LLM notepads** — private notes written by the stat LLM for its own reference between scenes, never injected into your main prompt
- **System prompt injection** — when a character is relevant/present, their enabled relationship data can be injected into your main prompt and removed when they leave
- **On-demand stat lookup tool** — when function calling is available, the main chat LLM can request an absent tracked character's relationship data without injecting the entire library every turn
- **Passive library reference** — optional full-library context injection for setups that prefer broad access over on-demand lookup
- **Character library** with manual creation, AI-assisted profile generation, and automatic blank-entry creation on new character detection
- **Search, filter, and sort** controls for the character library, including Present, Not present, No stats yet, alphabetical, present-first, and recently-updated views
- **Bulk character selection and deletion** for library maintenance
- **Folder organization** — characters can be sorted into named folders, with context menus for moving, renaming, exporting, and managing entries
- **Profile pictures** — upload a custom image per character; displays in both the character list chip and full profile screen
- **Name aliases and fuzzy matching** — alternate names and variants are used for presence detection and stat-update matching, with duplicate-card prevention when the LLM returns an alias instead of the canonical name
- **Update logs** — the last 5 stat change entries per character, with rollback and delete controls
- **Batch scan** with configurable context/token limits, rate limiting, retries, and optional combined-range processing for pre-existing chats
- **Historical maintenance scans** in Debug for backfilling Relationship Milestones and proposing missing Threshold Locks without rewriting established stats
- **Import / export tools** for RST settings and character data
- **Fully configurable** — separate connection profiles for each LLM role, scan cadence/context size, stat change range, critical chance, lock behavior, injection format, library reference behavior, batch-scan limits, and more

---

## Requirements

- SillyTavern 1.18.0 (or higher)
- At least one configured connection profile in ST's Connection Manager for stat updates
- A second connection profile for sidecar detection (this can be a smaller/faster/local model)
- Optional: a third profile for auto-generating character profiles
- Optional: a Chat Completion backend with tool calling enabled if you want to use the on-demand stat lookup tool

---

## Installation

1. Download or clone this repository into your SillyTavern extensions folder:
   ```
   SillyTavern/public/scripts/extensions/third-party/Relationship-Stat-Tracker/
   ```
2. Restart SillyTavern or reload the extensions panel.
3. The extension will appear in your Extensions menu as **Relationship Stat Tracker**.
4. Open the extension panel and go to **Settings** to configure your connection profiles before use.

---

## Setup

### Connection Profiles

RST uses three separate LLM roles. Go to **Settings → Connection Profiles** and assign a profile to each:

| Role | Purpose | Recommended |
|---|---|---|
| Stat update LLM | Reviews closed scenes and generates relationship changes | Your strongest model — emotional context and character judgment matter here |
| Sidecar detection LLM | Scans recent messages to determine current character involvement | A fast, lightweight model |
| Auto-gen profile LLM | Generates character profile text on demand | Mid-tier model or the same profile used for stat updates |

Profiles are pulled directly from ST's Connection Manager. Any compatible profile configured there will appear in the dropdowns.

### Detection Settings

Under **Settings → Detection Settings**:

- **Scan frequency** — how many live chat messages pass between automatic sidecar checks (default: 5)
- **Messages to scan** — how many recent messages the sidecar reads on each check (default: 10)
- **New character popup** — whether RST asks before creating a blank profile for an unknown detected character (default: on)
- **Name blacklist** — comma- or newline-separated names that should always be excluded from character detection

The cadence counter on Home counts both user and assistant messages. When a scan becomes due, the actual sidecar call waits for the next user message rather than firing on the assistant's response.

The sidecar can recognize several forms of active narrative involvement:

- **Physical** — character is physically in the current scene
- **Call / Message / Surveillance / Remote** — character is actively involved through a live or deliberate remote channel
- **Parallel** — the narrative camera is actively following the character elsewhere while they observe, decide, react to, or act on the current player-related thread

Merely mentioning an absent character, recalling them, planning to contact them, or reporting old information does not by itself make them present.

The **Pause sidecar** button on Home temporarily stops automatic presence scans without disabling the rest of RST. The status line shows whether the sidecar is ready, paused, running, disabled, or due on the next user message.

### Stat Settings

Under **Settings → Stat Settings**:

- **Stat change range** — ordinary minimum/maximum movement allowed per scene close (default: -5 to +5)
- **Critical changes** — enables rare, larger movement for genuinely pivotal relationship moments
- **Critical chance** — RNG chance that an LLM-flagged critical candidate actually fires (default: 15%)
- **Hard locks** — enforce personality/history-based caps on individual stats (default: on)
- **Soft locks** — enforce conditional caps that can unlock when their requirement is met (default: on)
- **Max active soft locks** — ceiling of 1–3 simultaneous active soft locks per character (default: 1)

Hard and Soft lock generation requires the character's **Personality** field to contain enough information for the LLM to judge the character's psychology.

Use **Save Stat Settings** after editing the range or other stat controls.

### Injection Settings

Under **Settings → Injection Settings**:

- **Inject stat block** — toggle automatic relationship-stat injection on or off
- **Inject character profile** — also inject enabled profile text alongside stats; uses more tokens
- **Injection format** — Stats only or Stats + narrative
- **Injection placement** — where the relationship block appears relative to the character card
- **Passive library reference** — inject the tracked library as freely referenceable context for the main LLM (off by default; uses more tokens)
- **Stat lookup tool (function calling)** — lets the main LLM request a tracked character's current relationship data on demand, including absent characters, without permanently injecting the whole library
- **Library reference depth / role** — controls placement and speaker role for the passive library block

Per-character visibility controls in the Library are authoritative. If Personality, Notes, or one of the three relationship categories is hidden, RST will omit that material from prompt injection and prevent the stat-update systems from generating changes for the hidden category.

---

## How to Use

### Starting a Scene

When a new scene begins in your chat, click the **▶ Scene start** button that appears in the message action bar. This marks the starting message index and opens a scene entry.

Only one scene can be open at a time.

### Ending a Scene

When the scene ends, click the **■ Scene end** button on any message. RST will:

1. Close the scene and record the ending message immediately.
2. Call your stat-update LLM with the scene messages and relevant character relationship state.
3. Generate proposed stat changes for the characters involved.
4. Evaluate applicable Critical changes, Threshold Locks, Milestones, temporary Conditions, and relationship-state maintenance.
5. Generate a scene summary as an internal LLM notepad entry.
6. Display the results in the **Pending Updates** section on the Home tab.

The scene is considered closed before the LLM finishes generating, so a slow API response will not leave the UI looking as though the scene is still open. RST also guards against overlapping Scene End requests.

### Reviewing Pending Updates

After a scene closes, the Home tab shows a Pending Updates section. For each character you can:

- **Approve changes** — commits that character's proposed update
- **Regenerate** — re-runs the LLM, optionally with additional guidance you provide
- **Edit manually** — adjust proposed values before approving

At the bottom, **Approve all** commits everything at once. **Dismiss all** discards all pending changes without saving.

Nothing is written to the character's relationship history until you explicitly approve the update.

---

## Character Library

### Creating Characters

**Manual** — Click **+ New character**. Fill in the name, Personality, Notes, aliases, and any other information you want RST to use.

**AI-assisted** — Open a character's profile and click the **wand** button. Optionally provide guidance, then generate profile text from your prompt or the available scene context.

**Auto-detected** — When the sidecar finds an unknown name and the new-character popup is enabled, RST can create a blank profile containing only the detected name. This does not spend an additional profile-generation call; fill the profile manually or use the wand later.

Initial stat generation resolves canonical names, saved aliases, and fuzzy matches into the existing character profile so an LLM returning a name variant does not create a second copy of the same character.

### Search, Filter, Sort, and Bulk Maintenance

The Library includes:

- Full-text character-name search
- **All**, **Present**, **Not present**, and **No stats yet** filters
- **A → Z**, **Z → A**, **Present first**, and **Recently updated** sorting
- Bulk selection and bulk deletion

### Name Aliases

Each profile has a **Name Aliases** field for alternate names, nicknames, titles, and variants. RST uses aliases during presence detection and stat-update matching.

Canonical/alias/fuzzy matching is also used when parsing LLM results. If the model returns both a canonical name and an alias for the same character, RST deduplicates the result instead of creating duplicate pending-update cards.

### Profile Visibility

The eye control on a character profile lets you selectively hide:

- Personality
- Notes
- Platonic stats
- Romantic stats
- Sexual stats

Hidden data remains stored in the profile, but it is excluded from prompt injection and from the corresponding LLM update/lock logic until made visible again.

### Folders

Characters can be organized into named folders. Click **+ New folder** to create one. Right-click any character chip to access folder and profile-management actions.

Deleting a folder never deletes the characters inside it — they are moved to **Unfiled** automatically.

### Profile Pictures

Click the avatar on a character's profile to upload and crop an image. The image is stored with that character's profile and replaces the initials display in both the Library chip and profile screen.

### Update Log

The clock icon on a character profile shows the last 5 stat update entries. Each entry can include the complete before→after relationship state, per-stat commentary, Critical markers, inertia adjustments, and other information associated with that approved update.

**Rollback** restores the character's stats to their state before that entry. **Delete** removes only the selected log entry.

---

## Relationship Progression Systems

### Critical Stat Changes

Most scenes use the configured ordinary Stat Change Range. A stat can only become a Critical candidate when the stat-update LLM identifies a genuinely pivotal, story-defining moment such as a major betrayal, confession, rescue, or profound act of vulnerability.

Being flagged does not guarantee a Critical change. The candidate must also pass the configured RNG chance. A fired Critical receives a wider movement ceiling (currently 3× the normal range) and bypasses ordinary relationship inertia for that stat.

### Relationship Trajectory

Trajectory is derived deterministically from approved relationship history rather than generated by another LLM call. It summarizes the direction and stability of recent movement using labels such as **Baseline**, **Stable**, **Gradually Warming**, **Rapidly Deteriorating**, **Polarized**, **Volatile**, **Rebuilding**, and **Fragile** when the available history supports them.

Trajectory is a read-only interpretation of existing approved data. It does not directly alter stats.

### Relationship Inertia

Inertia uses recent approved stat movement to resist implausible acceleration or abrupt reversals. It is deliberately conservative:

- It can reduce an ordinary proposed delta.
- It never increases a proposed delta.
- It does not apply until enough comparable approved history exists.
- Fired Critical changes bypass it.
- Volatile or polarized trajectories allow more reversal flexibility.

When inertia changes a pending value, RST shows the proposed delta and adjusted delta in the update UI.

### Relationship Milestones

Milestones are durable records of meaningful turning points in a relationship. They are kept separately from the numeric stat matrix so major developments remain readable even after the raw values continue moving.

Milestones can be proposed during normal stat updates, reviewed with the rest of the pending character update, and viewed/edited/deleted from the character profile.

For older chats, **Settings → Debug → Backfill Relationship Milestones** can scan visible history and propose retrospective milestones for review. The backfill does not modify relationship stats.

### Temporary Relationship Conditions

Conditions represent temporary contextual states rather than permanent personality traits. Examples include **Guarded**, **Suspicious**, **Resentful**, **Protective**, **Vulnerable**, **Jealous**, **Conflicted**, **Trust Under Review**, and **Post-Rupture Repair**.

RST can add at most one new condition per character in a single relationship update and keeps no more than four active conditions on that character at once. Each condition stores why it is active and what narrative development should resolve it. Resolved conditions remain part of the relationship record instead of being treated as permanent stat modifiers.

### Threshold Locks

Threshold Locks are optional relationship barriers intended to keep stat progression consistent with the character's Personality, psychology, and history.

#### Hard Locks

A Hard Lock places a cap on one individual stat. Ordinary positive movement cannot push the stat above that cap. A fired Critical can break through the ceiling and raise it when the scene genuinely warrants exceptional movement.

Hard Locks can be created or edited manually and may also be proposed by the stat-update LLM when the character has sufficient Personality information.

Existing Hard Locks also carry a **pressure** value. Pressure represents sustained evidence that the character is behaving against the psychological reason for the cap; it does **not** directly increase the stat. When pressure reaches its review threshold, the LLM can recommend maintaining the lock, raising the cap, converting it to a Soft Lock, or removing it. The user makes the final decision.

#### Soft Locks

A Soft Lock is a conditional cap tied to a specific narrative requirement. Growth remains capped until the condition is satisfied. The stat-update system can track progress toward the condition and mark the lock met when the story clearly fulfills it.

Resolved Soft Locks remain visible as unlocked history. The configurable **Max active soft locks** setting is a ceiling, not a target — the LLM is not expected to fill every available slot.

#### Historical Lock Scan

**Settings → Debug → Scan for Threshold Locks** can review the visible chat history alongside Personality, Notes, current stats, Trajectory, Milestones, Conditions, summaries, and existing locks. Existing lock slots are preserved; the scan only proposes missing locks, and the user reviews proposals before anything is applied.

---

## Scenes Tab

The Scenes tab lists closed scenes chronologically. Each entry is expandable and includes its LLM-written scene summary — the private notepad entry created when the scene closed.

Scene summaries are intended for RST's own relationship analysis and are never injected into the main ST roleplay prompt.

Summaries can be edited. Deleting a scene removes the scene record and its summary.

---

## Settings Reference

| Setting | Description | Default |
|---|---|---|
| Stat update LLM | Connection profile for scene review and relationship generation | — |
| Sidecar detection LLM | Connection profile for character-presence scanning | — |
| Auto-gen profile LLM | Connection profile for profile generation | — |
| Batch scan | One-time processing for pre-existing chat history | — |
| Scene summary prompt | Editable prompt controlling RST's internal scene summaries | See below |
| Stat change range | Ordinary min/max points a stat can shift per scene close | -5 to +5 |
| Critical changes | Permit rare expanded-range movement on pivotal moments | On |
| Critical chance | Chance an LLM-flagged candidate actually fires | 15% |
| Hard locks | Enforce per-stat psychological caps | On |
| Soft locks | Enforce conditional caps that can unlock | On |
| Max active soft locks | Maximum simultaneous active Soft Locks per character | 1 |
| Scan frequency | Live chat messages between sidecar checks | 5 |
| Messages to scan | Recent messages included in each sidecar check | 10 |
| New character popup | Prompt on unknown character detection | On |
| Name blacklist | Per-chat names excluded from sidecar detection | Empty |
| Inject stat block | Auto-inject enabled relationship stats for relevant characters | On |
| Inject character profile | Also inject enabled Personality/Notes fields | On |
| Injection format | Stats only / Stats + narrative | Stats + narrative |
| Injection placement | Position of the relationship block | Above character card |
| Passive library reference | Inject broad relationship-library context | Off |
| Stat lookup tool | Allow on-demand relationship lookup through function calling | On |
| Library reference depth | Context placement for passive library reference | Below character card |
| Library reference role | Prompt role used for passive library reference | System |
| Debug F12 logging | Show routine RST activity logs in the browser console | Off |

### Default Scene Summary Prompt

> Write a concise scene summary for internal reference. Include: key events, emotional turning points, characters present, and any significant relationship shifts. Keep it clinical and factual — this is a note for future analysis, not a narrative retelling.

---

## Batch Scan

For long or pre-existing chats, **Run batch scan** in Settings can process existing history to establish RST data without requiring you to replay the chat manually.

The batch process can:

1. Scan chat history for scene boundaries and character names.
2. Create blank character profiles for newly detected names.
3. Generate initial relationship stats for characters based on the available history.
4. Generate internal scene summaries for detected scenes.

Batch Scan avoids treating an existing zero-stat profile as an unrelated new character when the model returns an alias or fuzzy name match.

### Batch Scan Controls

| Setting | Description | Default |
|---|---|---|
| Scene detection max tokens | Maximum token budget used for scene-detection chunks | 4000 |
| Initial stat max tokens | Maximum token budget used for initial-stat generation chunks | 3000 |
| Requests per minute | Maximum LLM API calls per minute per connection profile | 10 |
| Max retries | Retries for rate-limit/server failures | 3 |
| Base retry delay | Starting delay before retry; increases on repeated failures | 1000ms |
| Per-scene delay | Optional pause between stat-generation calls | 0ms |
| Inter-phase delay | Optional pause between major batch phases | 0ms |
| Combine ranges in single call | Combine unprocessed ranges when they fit available context | On |

If a provider begins returning rate-limit errors during a scan, lower Requests per minute and/or increase the retry delay.

---

## Stat Structure Reference

Every character has exactly 12 possible relationship stats across three fixed categories:

```
Platonic  — Trust, Openness, Support, Affection
Romantic  — Trust, Openness, Support, Affection
Sexual    — Trust, Openness, Support, Affection
```

Values are bounded to `[-100, 100]` and can be negative. Positive values display in green, negative values in red, and zero/neutral values in grey.

Ordinary per-scene movement is bounded by your configured Stat Change Range. Critical changes, Threshold Locks, hidden stat categories, and inertia can further alter how a proposed update is resolved.

Approved stat changes are recorded in the character's update history with relationship commentary so the system has continuity beyond the raw percentage values.

---

## Function Calling / Stat Lookup

When **Stat lookup tool (function calling)** is enabled and the active Chat Completion backend supports tools, RST registers an on-demand relationship lookup tool for the main LLM.

The tool can resolve a tracked character by canonical name, alias, or fuzzy match and return the relevant current relationship state. This can include current stats/profile information plus context such as Trajectory, active temporary Conditions, and recent Milestones.

The purpose is to let the main model deliberately retrieve an absent NPC's relationship state when it matters without paying the token cost of injecting every tracked profile on every turn.

This is optional. RST still works without function calling.

---

## Data Storage

- **Global extension settings** (`extension_settings.rst`) — connection profiles, behavior settings, injection preferences, and other global RST configuration
- **Per-chat RST metadata** — character profiles, folders, presence state, scenes, relationship history, pending updates, blacklist data, and other chat-specific state

Character profiles are intentionally per-chat. The same fictional character appearing in two different chat files can therefore maintain different relationship histories.

The Settings **Export all** function exports the current RST settings and character profiles to JSON. Character-profile export controls are also available from the Library.

---

## Known Limitations (Alpha)

- Slash commands are not currently implemented; use the message action buttons and extension UI instead.
- Batch Scan quality and performance on very long chats still depend on the context window and instruction-following ability of the selected LLM.
- Character profiles are stored per-chat, so the same character appearing in multiple independent chat files maintains separate RST data unless you manually export/import the profile data.
- Pending approval is primarily character-update based rather than a separate approval transaction for every individual stat.
- Presence detection is intentionally conservative. Ambiguous references, malformed sidecar output, or narrative structures the sidecar cannot confidently resolve may require manual correction.
- As with any LLM-assisted state tracker, generated profiles, stats, locks, conditions, milestones, and summaries should occasionally be reviewed and corrected when the model makes a bad judgment.

---

## Version

**0.1.0** — Alpha release  
Author: ExtensionMuncher
