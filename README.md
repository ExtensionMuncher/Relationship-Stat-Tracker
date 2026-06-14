# Relationship State Tracker (RST)

A SillyTavern extension that tracks relationship stats between characters across roleplay sessions. RST uses a lightweight sidecar LLM to detect which characters are present in your chat, and a main LLM to review closed scenes and generate nuanced stat updates — all without interrupting your primary AI or burning unnecessary tokens.

> **Status: Alpha** — Core systems are functional. Some features are still being stabilized. Expect rough edges. Back up your ST data before use.

---

## Features

- **Automatic character presence detection** via a configurable sidecar LLM that scans messages every few exchanges
- **12-stat relationship matrix** per character — three fixed categories (Platonic, Romantic, Sexual), each with four stats (Trust, Openness, Support, Affection) — all expressed as percentages that can go negative
- **Scene management** with Scene Start and Scene End buttons added directly to your chat messages
- **Stat updates on scene close** — the main LLM reviews what happened in the scene and proposes before→after changes for every stat, with per-stat commentary and a narrative summary
- **User approval flow** — proposed changes are held in a Pending Updates section on the Home tab and never committed until you approve them
- **Scene summaries as LLM notepads** — private notes written by the stat LLM for its own reference between sessions, never injected into your main prompt
- **System prompt injection** — when a character is detected as present, their full stat block is automatically injected into your system prompt and removed when they leave
- **Character library** with manual creation, AI-assisted profile generation, and automatic blank-entry creation on new character detection
- **Folder organization** — characters can be sorted into named folders, with right-click context menus for moving, renaming, and managing entries
- **Profile pictures** — upload a custom image per character; displays in both the character list chip and the full display screen
- **Name aliases** — define alternate names and variants per character so the sidecar detects them reliably across different name formats
- **Update logs** — the last 5 stat change entries per character, with rollback and delete
- **Batch scan** with built-in rate limiting — scans pre-existing chats to auto-detect scenes and characters, with configurable rate limiting and retry settings to avoid hitting API provider limits
- **Fully configurable** — separate connection profiles for each LLM role, adjustable scan frequency, stat change range limits, injection format controls, and passive library reference options

---

## Requirements

- SillyTavern 1.18.0 (or higher)
- At least one configured connection profile in ST's Connection Manager for stat updates
- A second connection profile for sidecar detection (can be a smaller/faster/local model — Gemma 3 4b via Ollama works well)
- Optional: a third profile for auto-generating character profiles

---

## Installation

1. Download or clone this repository into your SillyTavern extensions folder:
   ```
   SillyTavern/public/scripts/extensions/third-party/Relationship-Stat-Tracker/
   ```
2. Restart SillyTavern or reload the extensions panel
3. The extension will appear in your Extensions menu as **Relationship Stat Tracker**
4. Open the extension panel and go to **Settings** to configure your connection profiles before use

---

## Setup

### Connection Profiles

RST uses three separate LLM roles. Go to **Settings → Connection profiles** and assign a profile to each:

| Role | Purpose | Recommended |
|---|---|---|
| Stat update LLM | Reviews closed scenes and generates stat changes | Your strongest model — emotional context matters here |
| Sidecar detection LLM | Scans messages to detect character presence | A fast, lightweight model — does not need to be frontier |
| Auto-gen profile LLM | Generates character profile descriptions on demand | Mid-tier or same as stat update |

Profiles are pulled directly from ST's Connection Manager. Any profile you have configured there will appear in the dropdowns.

### Detection Settings

Under **Settings → Detection settings**:

- **Scan frequency** — how many messages pass between sidecar scans (default: every 5 messages)
- **New character popup** — whether to prompt you when an unknown character is detected (recommended: on)

### Injection Settings

Under **Settings → Injection settings**:

- **Inject stat block** — toggle automatic system prompt injection on or off
- **Inject character profile** — also inject name, description, and notes alongside stats (uses more tokens)
- **Injection format** — Stats only or Stats + narrative summary
- **Injection placement** — where in the system prompt the block appears
- **Passive library reference** — allows the stat LLM to passively access all character profiles even when not present in the current scene (off by default — uses more tokens)

---

## How to Use

### Starting a Scene

When a new scene begins in your chat, click the **▶ Scene start** button that appears in the message action bar. This marks the starting message index and opens a scene entry.

Only one scene can be open at a time.

### Ending a Scene

When the scene ends, click the **■ Scene end** button on any message. RST will:

1. Close the scene and record the ending message
2. Call your stat update LLM with the scene's messages, each character's current stats, and all prior scene summaries
3. Generate proposed stat changes for every character present
4. Generate a scene summary as an internal LLM notepad entry
5. Display the results in the **Pending Updates** section on the Home tab

### Reviewing Pending Updates

After a scene closes, the Home tab shows a Pending Updates section. For each character you can:

- **Approve changes** — commits that character's stats permanently
- **Regenerate** — re-runs the LLM, optionally with additional guidance you type in
- **Edit manually** — adjust values directly before approving

At the bottom: **Approve all** commits everything at once. **Dismiss all** discards all pending changes without saving. Nothing is written to your character data until you explicitly approve it.

---

## Character Library

### Creating Characters

**Manual** — Click **+ New character**. Fill in name, description, notes, and name aliases.

**AI-assisted** — Open any character's display screen and click the **✦ wand** button. Optionally type a guidance prompt, then choose Generate from prompt or Generate from scene.

**Auto-detected** — When the sidecar finds an unknown name and the new character popup is enabled, a dialog asks whether to create a blank profile entry. Confirming creates the entry with only the name filled in — no tokens spent. Fill it in manually or use the wand later.

### Name Aliases

Each character profile has a **Name Aliases** field for alternate names, nicknames, and name variants (comma-separated). The sidecar uses these when scanning for character presence, so characters with multiple name formats are detected correctly.

### Folders

Characters can be organized into named folders. Click **+ New folder** to create one. Right-click any character chip to access Move to folder, Rename, Export profile, or Delete.

The folder label shown under a character's name in the display screen is also clickable and opens the same folder picker.

Deleting a folder never deletes characters — all characters inside are moved to Unfiled automatically.

### Profile Pictures

Click the avatar circle on any character's display screen to upload an image. The image is stored as base64 in the character's profile and replaces the initials display in both the character list and the display screen.

### Update Log

The ◷ clock icon on any character's display screen shows the last 5 stat update entries. Each entry includes the complete before→after record for all 12 stats (including zero-change entries with explanations), per-stat commentary, and the message range the update covers.

**Rollback** restores the character's stats to their state before that entry. **Delete** removes only that log entry.

---

## Scenes Tab

Lists all closed scenes chronologically. Each entry is expandable and shows an editable LLM summary — the private notepad entry written by the stat LLM when the scene closed. These summaries are never injected into your main ST prompt. Delete a scene to remove it and its summary entirely.

---

## Settings Reference

| Setting | Description | Default |
|---|---|---|
| Stat update LLM | Connection profile for scene review and stat generation | — |
| Sidecar detection LLM | Connection profile for character presence scanning | — |
| Auto-gen profile LLM | Connection profile for profile generation | — |
| Batch scan | One-time scan of full chat history | — |
| Scene summary prompt | Editable prompt for how the LLM writes scene summaries | See below |
| Stat change range | Min/max points a stat can shift per scene close | -5 to +5 |
| Scan frequency | Messages between sidecar detection calls | 5 |
| New character popup | Prompt on unknown character detection | On |
| Inject stat block | Auto-inject present characters' stats into system prompt | On |
| Inject character profile | Also inject name, description, notes | On |
| Injection format | Stats only / Stats + narrative | Stats + narrative |
| Injection placement | Position in system prompt | Above character card |
| Passive library reference | LLM can access all profiles even when not present | Off |

### Default Scene Summary Prompt

> Write a concise scene summary for internal reference. Include: key events, emotional turning points, characters present, and any significant relationship shifts. Keep it clinical and factual — this is a note for future analysis, not a narrative retelling.

---

## Batch Scan

For long or pre-existing chats, **Run batch scan** in Settings will:

1. Scan your full chat history to detect scene boundaries and character names
2. Create blank character profiles for any unrecognised names
3. Generate an initial stat block per character based on the full history
4. Generate scene summaries for detected scenes

Batch scan runs once and does not compound on existing data.

### Rate Limiting

Batch scan has built-in rate limiting and retry handling. All values are configurable under the batch scan options in Settings:

| Setting | Description | Default |
|---|---|---|
| Requests per minute | Maximum LLM calls per minute during the scan | 10 |
| Max retries | How many times to retry a failed request before giving up | 3 |
| Base retry delay | Starting delay in ms before the first retry (doubles on each attempt) | 1000ms |
| Per-scene delay | Additional pause between scene processing steps | 0ms |
| Inter-phase delay | Pause between major scan phases | 0ms |

If you are hitting 429 errors during a scan, reduce requests per minute and increase the base retry delay.

---

## Stat Structure Reference

Every character has exactly 12 stats across three fixed categories:

```
Platonic  — Trust, Openness, Support, Affection
Romantic  — Trust, Openness, Support, Affection
Sexual    — Trust, Openness, Support, Affection
```

All values are percentages and can be negative. Positive values display in green, negative in red, zero in grey. Stats are bounded to [-100, 100]. Per-scene changes are bounded by your configured stat change range (default -5 to +5).

Every stat change — including zero-change entries — is recorded in the update log with a written explanation.

---

## Data Storage

- **Global extension settings** (`extension_settings.rst`) — configuration, connection profiles, preferences. Shared across all chats.
- **Per-chat metadata** (`chat_metadata.rst`) — character profiles, folders, scenes, stat history, and pending updates. Specific to each chat file.

Use the Export and Import options in the Character Library or Settings to move data between chats.

---

## Planned Features

### Critical Stat Changes
Certain significant moments within a roleplay scene will trigger a stat change at three times the normal configured range. These moments are determined by the stat update LLM based on narrative weight, making large relationship shifts feel earned rather than mechanical. The threshold multiplier and what qualifies as a critical moment are both RNG-influenced, keeping outcomes unpredictable.

### Threshold Locks

To enhance the quality and realism of characters, I will introduce a stat lock/unlock system to provide more emotional depth to roleplays. This is a toggleable feature, meaning you do *not* have to use it if you don't want to. If you do decide to use it, the Personality section of the Character Profile is required to be filled in so the LLM has a reference point of the respective character's traits in order to make decisions on when/how to place locks and unlocks.

#### Hard Locks
The stat update LLM will be able to set hard caps on individual stats based on a character's personality, psychology, and history. A heavily traumatized character who struggles with trust may have a hard lock on their Trust stats that prevents growth beyond a certain point regardless of what happens in scenes — keeping stat progression true to who the character is.

#### Soft Locks (Unlockable)
A softer cap that pauses growth in a specific stat until defined conditions are met. The user character may need to reach a certain threshold in another stat, perform specific actions, or meet narrative requirements before growth resumes. Soft locks are designed to be broken — they represent barriers to intimacy or connection that can be overcome through the story, not permanent ceilings.

## Function Calling

Allowing your main LLM to use tool-calling features (if the LLM supports it) to have access to NPC stats even if they aren't actively present.

### Search and Filter
Full text search across the character library, with filter controls for presence status, folder, and stats state.

### Slash Commands
Slash command support for triggering scene start/end and other RST actions directly from the ST chat input.

---

## Known Limitations (Alpha)

- Slash command support is currently a placeholder — not yet functional
- Batch scan performance on very long chats depends on your stat update LLM's context window
- Character profiles are stored per-chat — a character appearing across multiple chat files needs a separate profile in each
- The stat approval flow does not yet support approving individual stat changes — approval is per character

---

## Version

**0.1.0** — Alpha release
Author: ExtensionMuncher
