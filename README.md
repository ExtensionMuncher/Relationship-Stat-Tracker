# Relationship Stat Tracker (RST)

A SillyTavern extension that tracks relationship stats and ongoing relationship state between characters across roleplay sessions. RST uses a lightweight sidecar LLM to detect which characters are actively involved in the current narrative, and a main LLM to review closed scenes and propose nuanced relationship updates — all without interrupting your primary AI or committing changes without approval.

> **Status: Alpha** — Core systems are functional. Some features are still being stabilized. Expect rough edges. Back up your ST data before use.

---

## Features

### Relationship Tracking

- **12-stat relationship matrix** per character across Platonic, Romantic, and Sexual categories, with Trust, Openness, Support, and Affection tracked from `-100%` to `100%`
- **Critical stat changes** for rare pivotal moments that justify movement beyond the normal configured range
- **Hard and soft threshold locks** that keep progression consistent with character psychology, history, and unresolved narrative barriers
- **Relationship milestones** for durable turning points that should remain part of the relationship's history
- **Temporary relationship conditions** for current states such as guardedness, suspicion, resentment, protectiveness, or conflict
- **Trajectory and inertia analysis** that uses approved relationship history to discourage unsupported acceleration or abrupt reversals
- **User approval flow** that holds numeric and structural proposals in Pending Updates until they are reviewed
- **Update logs** with rollback and delete controls
- **Milestone and threshold-lock backfills** for retroactively reviewing existing chat history

### Scene Workflow

- **Scene management** with Scene Start and Scene End buttons added directly to chat messages
- **Synchronized scene status** across the Home header, scene notices, message controls, and Scenes tab
- **Stat updates on scene close** with proposed before→after changes, per-stat commentary, structural relationship updates, and a narrative summary
- **Scene summaries as LLM notepads** for future relationship analysis without automatic injection into the main prompt
- **Batch scanning** with rate limiting, retry handling, scene detection, character discovery, initial stat generation, and scene summaries

### Presence Detection and Prompt Integration

- **Automatic character presence detection** through a configurable sidecar LLM that scans recent messages on a set cadence
- **Multiple presence modes** for physical scenes, live calls, active messaging, surveillance, other remote involvement, and parallel active scenes
- **Live sidecar cadence status** on the Home tab showing whether detection is ready, paused, disabled, scanning, or due on the next user message
- **Name aliases and blacklist controls** for more reliable character matching and cleaner automatic detection
- **System prompt injection** that adds and removes present characters' relationship data as involvement changes
- **Optional relationship-stat lookup tool** for main LLMs that support function calling

### Character Library and Data Management

- **Character library** with manual creation, AI-assisted profile generation, and automatic blank-entry creation when a new character is detected
- **Character search, filtering, and sorting** by name, presence, stat state, and update activity
- **Folder organization** with right-click controls for moving, renaming, exporting, and deleting entries
- **Profile pictures** stored per character and displayed in list and full-profile views
- **Import and export tools** for extension data, individual profiles, and editable prompt text

### Configuration

- **Separate connection profiles** for scene review, sidecar detection, and profile generation
- **Per-profile no-think controls** for supported backends
- **Configurable scan windows and cadence** for presence detection and batch processing
- **Configurable stat ranges, critical-change behavior, locks, injection format, and passive library reference options**

---

## Requirements

- SillyTavern 1.18.0 or higher
- At least one configured connection profile in ST's Connection Manager for stat updates
- A second connection profile for sidecar detection is recommended; this can be a smaller, faster, or local model
- Optional: a third profile for auto-generating character profiles
- Optional: a Chat Completion backend with function calling enabled for the relationship-stat lookup tool

---

## Installation

1. Download or clone this repository into your SillyTavern extensions folder:
   ```
   SillyTavern/public/scripts/extensions/third-party/Relationship-Stat-Tracker/
   ```
2. Restart SillyTavern or reload the extensions panel.
3. The extension will appear in the Extensions menu as **Relationship Stat Tracker**.
4. Open the extension panel and go to **Settings** to configure connection profiles before use.

---

## Setup

### Connection Profiles

RST uses three LLM roles. Go to **Settings → Connection Profiles** and assign a profile to each:

| Role | Purpose | Recommended |
|---|---|---|
| Stat update LLM | Reviews closed scenes and generates relationship changes | Your strongest model — emotional and narrative context matter here |
| Sidecar detection LLM | Reconciles current character involvement | A fast, lightweight model |
| Auto-gen profile LLM | Generates character profile descriptions on demand | Mid-tier or the same profile used for stat updates |

Profiles are pulled directly from ST's Connection Manager. Any profile configured there will appear in the dropdowns.

Each assigned profile also has optional **soft** and **hard** no-think controls:

- **Soft** appends `/no_think` to supported requests.
- **Hard** also sends API parameters that disable reasoning. Turn this off if a backend rejects unknown parameters.

### Detection Settings

Under **Settings → Detection Settings**:

- **Messages to scan** — how many recent prose messages are provided to the sidecar on each run
- **Scan frequency** — how many live chat messages must pass before another automatic scan becomes due
- **Pause / Resume** — temporarily suspends automatic presence reconciliation without disabling RST
- **New character popup** — whether to prompt when an unknown active character is detected
- **Name blacklist** — names that should never create or match character profiles during detection

The Home tab includes a compact cadence indicator. Cadence counts both user and character messages, but the automatic sidecar request runs on the next user message after the configured threshold is reached.

The sidecar distinguishes active physical presence from live calls, messaging, surveillance, other remote channels, and parallel active scenes. Mentioned, remembered, hypothetical, or purely reported characters are not treated as present.

### Stat Settings

Under **Settings → Stat Settings**:

- **Stat change range** — normal minimum and maximum movement permitted per scene
- **Critical changes** — allows rare pivotal moments to exceed the normal range
- **Critical chance** — controls how often an LLM-flagged pivotal change actually becomes critical
- **Hard Locks** — enables fixed caps or floors supported by character history and psychology
- **Soft Locks** — enables conditional barriers that can be unlocked through the story
- **Maximum active soft locks** — limits simultaneous unresolved soft locks per character

Use **Save Stat Settings** after adjusting these values.

### Injection Settings

Under **Settings → Injection Settings**:

- **Inject stat block** — toggles automatic relationship-stat injection
- **Inject character profile** — also includes name, description, and notes
- **Injection format** — Stats only or Stats + narrative
- **Injection placement** — top of prompt, above the character card, or below the character card
- **Passive library reference** — provides the main LLM with broader relationship-library context even when a character is not currently present
- **Stat lookup tool** — registers a function tool that lets a compatible main LLM request one character's relationship data on demand
- **Library reference depth and role** — controls where and under which message role passive library context is injected

---

## How to Use

### Starting a Scene

When a new scene begins, click the **▶ Scene start** button in the message action bar. This marks the starting message index and opens a scene entry.

Only one scene can be open at a time. The Home header and scene notices update immediately so the currently open scene remains visible across the interface.

### Ending a Scene

When the scene ends, click the **■ Scene end** button on any message. RST will:

1. Close the scene and record its ending message.
2. Update the interface immediately, before the LLM request begins.
3. Call the stat update LLM with the scene messages, current relationship data, relevant history, active locks, milestones, conditions, and trajectory context.
4. Generate proposed stat changes and structural relationship updates for each applicable character.
5. Generate a scene summary as an internal LLM notepad entry.
6. Display the results in **Pending Updates** on the Home tab.

Double-click protection prevents overlapping scene-close requests. If generation takes longer than expected, the scene remains closed and RST reports that the LLM is still working rather than leaving the interface looking stuck.

### Reviewing Pending Updates

After a scene closes, the Home tab shows a Pending Updates section. Depending on what occurred, a proposal may include:

- Numeric stat changes
- Critical-change flags
- Hard or soft lock changes
- New relationship milestones
- New, updated, or resolved temporary conditions
- Trajectory and inertia information
- A scene summary and relationship commentary

For each character you can:

- **Approve changes** — commits the reviewed proposal
- **Regenerate** — re-runs the LLM, optionally with additional guidance
- **Edit manually** — adjusts proposed values or structural entries before approval

At the bottom, **Approve all** commits all pending character proposals. **Dismiss all** discards them. Structural relationship changes remain reviewable even when a scene produces no numeric stat movement.

Nothing is written to approved relationship history until you explicitly approve it.

---

## Character Library

### Creating Characters

**Manual** — Click **+ New character** and fill in the profile fields.

**AI-assisted** — Open a character's display screen and click the **✦ wand** button. Optionally provide guidance, then generate from a prompt or scene context.

**Auto-detected** — When the sidecar finds an unknown active name and the popup is enabled, RST asks whether to create a blank profile. Confirming creates only the profile shell; you can complete it manually or use the wand later.

Initial stat generation resolves canonical names, saved aliases, and fuzzy matches into existing blank profiles. It does not intentionally create a duplicate profile merely because the LLM returned a name variant.

### Search, Filter, and Sort

The Character Library includes:

- Name search
- Present, absent, and no-stats filters
- Alphabetical sorting
- Sorting by recent update activity

### Name Aliases

Each profile has a **Name Aliases** field for alternate names, nicknames, honorific forms, and variants. Shared matching logic uses canonical names, aliases, and conservative fuzzy matching across sidecar detection and stat-update parsing.

Pending updates are deduplicated by character ID so a canonical name and one of its aliases do not create separate approval cards for the same character.

### Folders

Characters can be organized into named folders. Click **+ New folder** to create one. Right-click a character chip to move, rename, export, or delete it.

The folder label shown under a character's name in the display screen also opens the folder picker.

Deleting a folder never deletes the characters inside it; they are moved to Unfiled.

### Profile Pictures

Click the avatar on a character's display screen to upload an image. The image is stored in the character profile and replaces the initials display in both the list and profile screen.

### Relationship State

Each character profile can contain more than the 12 numeric stats:

- **Milestones** — rare, durable turning points that form part of the relationship's history
- **Conditions** — temporary current states that can be added, updated, or resolved
- **Trajectory** — a deterministic reading of approved stat history and recent direction
- **Inertia** — conservative resistance to unsupported acceleration or reversal
- **Hard Locks** — fixed stat boundaries with a recorded reason
- **Soft Locks** — conditional boundaries with an unlock condition and progress note

Milestones and conditions can be edited or deleted from the profile. Lock state and progress can also be reviewed and manually managed.

### Update Log

The ◷ clock icon opens the character's recent approved update history. Entries include before→after values, explanations, commentary, relevant structural changes, and the covered message range.

**Rollback** restores the character to the state before an entry. **Delete** removes only that log entry.

---

## Scenes Tab

The Scenes tab lists closed scenes chronologically. Each entry is expandable and shows an editable LLM summary — the private notepad entry written when the scene closed.

Scene summaries are not injected into the main ST prompt by default. They are used as internal reference for later relationship analysis.

Deleting a scene removes that scene and its summary. Scene deletion also refreshes the Home header and notices immediately so stale open-scene text is not left behind.

---

## Settings Reference

| Setting | Description | Default |
|---|---|---|
| Stat update LLM | Connection profile for scene review and relationship generation | — |
| Sidecar detection LLM | Connection profile for active-character reconciliation | — |
| Auto-gen profile LLM | Connection profile for profile generation | — |
| Messages to scan | Recent prose messages supplied to each sidecar request | 10 |
| Scan frequency | Live messages between automatic sidecar scans | 5 |
| Sidecar paused | Temporarily suspends automatic sidecar scans | Off |
| New character popup | Prompts when an unknown active character is detected | On |
| Name blacklist | Prevents selected names from being detected or created | Empty |
| Scene summary prompt | Editable instructions for internal scene summaries | See below |
| Stat change range | Normal min/max points a stat can shift per scene | -5 to +5 |
| Critical changes | Enables rare pivotal movement beyond the normal range | On |
| Critical chance | Chance an LLM-flagged pivotal change becomes critical | 15% |
| Critical multiplier | Maximum critical range multiplier | 3× |
| Hard Locks | Enforces fixed stat boundaries | On |
| Soft Locks | Enforces conditional, unlockable boundaries | On |
| Maximum active soft locks | Simultaneous unresolved soft-lock ceiling per character | 1 |
| Inject stat block | Injects present characters' stats | On |
| Inject character profile | Also injects description and notes | On |
| Injection format | Stats only / Stats + narrative | Stats + narrative |
| Injection placement | Position in the system prompt | Above character card |
| Passive library reference | Makes broader relationship data available as injected context | Off |
| Stat lookup tool | Registers `lookup_relationship_stats` when supported | On |
| Library reference depth | Placement of passive library context | Below character card |
| Library reference role | Message role used for passive library context | System |

### Default Scene Summary Prompt

> Write a concise scene summary for internal reference. Include: key events, emotional turning points, characters present, and any significant relationship shifts. Keep it clinical and factual — this is a note for future analysis, not a narrative retelling.

---

## Batch Scan

For long or pre-existing chats, **Run Batch Scan** in Settings can:

1. Scan visible chat history to detect scene boundaries and character names.
2. Create blank profiles for unrecognized characters.
3. Generate initial relationship stats from prior history.
4. Generate summaries for detected scenes.

Batch scan uses canonical names, aliases, and duplicate prevention to avoid creating multiple entries for the same character. Initial generation treats an existing all-zero profile as a true uninitialized profile rather than clamping it like an established relationship.

### Rate Limiting

Batch scan includes configurable rate limiting and retry handling:

| Setting | Description | Default |
|---|---|---|
| Requests per minute | Maximum LLM calls per minute | 10 |
| Max retries | Failed-request retry limit | 3 |
| Base retry delay | Starting delay before the first retry; increases on later attempts | 1000ms |
| Per-scene delay | Additional pause between scene-processing steps | 0ms |
| Inter-phase delay | Pause between major scan phases | 0ms |

If a provider returns 429 errors, reduce requests per minute and increase the retry delay.

### Milestone Backfill

**Backfill Relationship Milestones** reads existing visible chat history in chunks and proposes durable relationship turning points for existing profiles.

The scan does not alter stats. Results are saved for review and can be approved or discarded before they affect character data.

### Threshold Lock Scan

**Scan for Threshold Locks** reviews raw chat history, current stats, trajectory, milestones, conditions, existing locks, and established behavior before proposing hard or soft boundaries.

Results are reviewable before application. Existing occupied lock slots are preserved rather than overwritten unnecessarily.

---

## Stat Structure Reference

Every character has exactly 12 numeric stats across three fixed categories:

```
Platonic  — Trust, Openness, Support, Affection
Romantic  — Trust, Openness, Support, Affection
Sexual    — Trust, Openness, Support, Affection
```

Values are percentages bounded to `[-100, 100]` and may be negative. Positive values display in green, negative values in red, and zero in grey.

Normal per-scene movement is bounded by the configured stat change range. Critical changes can exceed that range when enabled and successfully triggered. Threshold locks, trajectory, and inertia may further limit or redirect proposed movement.

Every approved stat decision, including zero-change decisions when present in the proposal, can be recorded with an explanation.

---

## Relationship Systems

### Critical Stat Changes

The stat update LLM can flag a change as pivotal when a scene contains a relationship event with enough narrative weight to justify movement beyond the ordinary range. A configurable probability determines whether the flagged change becomes critical, and the multiplier controls the expanded ceiling.

Critical changes remain visible in Pending Updates before approval. They can also bypass ordinary inertia when the event genuinely supports a major shift.

### Threshold Locks

Threshold locks create stat caps or floors grounded in character psychology, history, and established relationship behavior.

#### Hard Locks

Hard Locks are fixed boundaries with a recorded reason. They are intended for durable constraints that should not move merely because one scene was positive or negative.

#### Soft Locks

Soft Locks are conditional boundaries with an unlock requirement and progress note. They represent barriers that can change through the story rather than permanent ceilings.

When the defined condition is met, the lock can resolve and normal movement can resume. The configured maximum is a ceiling on simultaneous active soft locks, not a target the LLM must fill.

### Relationship Milestones

Milestones preserve rare, durable turning points separately from ordinary update logs. They are meant for events that meaningfully redefine the relationship and should remain available as long-term context.

Milestones can be proposed during scene review or found through the historical backfill scan. All proposals remain reviewable before commit.

### Temporary Relationship Conditions

Conditions describe the character's current relationship state rather than permanent history. A character may become guarded, suspicious, resentful, protective, conflicted, or otherwise temporarily affected by current circumstances.

Conditions can be added, revised, and resolved as later scenes change the situation.

### Trajectory and Inertia

Trajectory is derived from approved stat history and recent relationship direction. Inertia uses that trajectory to discourage unsupported acceleration, sudden reversals, or disproportionately large movement.

These systems do not replace LLM judgment. They provide deterministic guardrails around proposed changes while allowing sufficiently important critical events to break through.

---

## Function Calling

When **Stat lookup tool** is enabled and the active Chat Completion backend supports function calling, RST registers:

```
lookup_relationship_stats
```

The main LLM can use this tool to request a tracked character's current relationship data even when that character is not actively present or automatically injected.

This tool is optional and does not affect ordinary sidecar detection or scene-close generation.

---

## Data Storage

- **Global extension settings** (`extension_settings.rst`) — connection profiles, generation preferences, stat rules, injection settings, and other extension-wide configuration
- **Per-chat metadata** (`chat_metadata.rst`) — character profiles, folders, current presence, scenes, milestones, conditions, locks, approved history, and pending updates for the active chat

Character data remains per chat. Use the available Import and Export controls to move data between chats or preserve backups.

Legacy evidence-only fields from older builds are cleaned from stored relationship records when encountered.

---

## Import / Export

RST provides controls for:

- Exporting and importing all extension data
- Exporting individual character profiles
- Importing character profiles into another chat
- Exporting and importing the editable scene-summary prompt

Review imported data before continuing a long-running chat, especially when importing from an older build.

---

## Tips

- Use a fast model for the sidecar and reserve the strongest model for scene review.
- Keep aliases focused on real name variants; overly broad aliases increase false matches.
- Add recurring false-positive names to the blacklist instead of repeatedly dismissing them.
- Fill in Personality when using threshold locks so the LLM has enough grounding to propose sensible boundaries.
- Keep scene boundaries meaningful. Extremely short or extremely broad scenes make relationship analysis less precise.
- Review structural changes even when numeric stats did not move; a milestone, condition, or lock may still matter.
- Export data before large batch scans, backfills, or major version changes.

---

## Known Limitations (Alpha)

- Batch scan and backfill performance on very long chats depends on the selected model's context window and provider limits.
- Character profiles and relationship history are stored per chat; the same character in another chat requires a separate profile or an import.
- Approval is primarily organized per character rather than as twelve completely separate stat approvals.
- Function calling requires a compatible Chat Completion backend and SillyTavern tool support.
- Sidecar detection is conservative by design and may require aliases or manual correction in unusually ambiguous prose.

---

## Version

**0.1.0** — Alpha release  
Author: ExtensionMuncher
