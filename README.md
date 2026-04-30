# Relationship State Tracker (RST)

A SillyTavern extension that tracks relationship stats between characters across roleplay sessions. RST uses a lightweight sidecar LLM to detect which characters are present in your chat, and a main LLM to review closed scenes and generate nuanced stat updates — all without interrupting your primary AI or burning unnecessary tokens.

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
- **Update logs** — the last 5 stat change entries per character, with rollback and delete
- **Batch scan** for long or pre-existing chats — auto-detects scenes and characters, generates profiles and summaries in one pass without compounding on existing data
- **Fully configurable** — separate connection profiles for each LLM role, adjustable scan frequency, stat change range limits, and injection format controls

---

## Requirements

- SillyTavern (recent version with extension support)
- At least one configured connection profile in ST's Connection Manager for stat updates
- A second connection profile for sidecar detection (can be a smaller/faster/local model)
- Optional: a third profile for auto-generating character profiles

---

## Installation

1. Download or clone this repository into your SillyTavern extensions folder:
   ```
   SillyTavern/public/scripts/extensions/third-party/SillyTavern-Relationship Stat Tracker/
   ```
2. Restart SillyTavern or reload the extensions panel
3. The extension should appear in your Extensions menu as **Relationship State Tracker**
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

- **Inject stat block** — toggle the automatic system prompt injection on or off
- **Inject character profile** — also inject name, description, and notes alongside stats (uses more tokens)
- **Injection format** — choose between Stats only or Stats + narrative summary
- **Injection placement** — where in the system prompt the block appears (above character card, below character card, top, or bottom)

---

## How to Use

### Starting a Scene

When a new scene begins in your chat, click the **▶ Scene start** button that appears in the message action bar. This marks the starting message index and opens a scene entry.

Only one scene can be open at a time. If you try to start a new scene while one is already open, RST will warn you.

### Ending a Scene

When the scene ends, click the **■ Scene end** button on any message. RST will:

1. Close the scene and record the ending message
2. Call your stat update LLM with the scene's messages, each character's current stats, and all prior scene summaries
3. Generate proposed stat changes for every character present
4. Generate a scene summary as an internal LLM notepad entry
5. Display the results in the **Pending Updates** section on the Home tab

### Reviewing Pending Updates

After a scene closes the Home tab will show a Pending Updates section at the top. This contains:

- The proposed scene summary (editable before approval)
- Per-character stat blocks showing before→after values for all 12 stats, with per-stat commentary, a dynamic title change, and a narrative summary

For each character you can:
- **Approve changes** — commits that character's stats permanently
- **Regenerate** — re-runs the LLM, optionally with additional guidance you type in
- **Edit manually** — adjust values directly before approving

At the bottom:
- **Approve all** — commits everything at once
- **Dismiss all** — discards all pending changes without saving

Nothing is written to your character data until you explicitly approve it.

---

## Character Library

### Creating Characters

There are three ways to add a character:

**Manual** — Click **+ New character** at the top of the Character Library tab. Fill in the name, description, and notes fields yourself.

**AI-assisted** — Open any character's display screen and click the **✦ wand** button. You can optionally type a guidance prompt, then choose:
- **Generate from prompt** — uses your guidance to write the profile
- **Generate from scene** — pulls from current scene context instead

**Auto-detected** — When the sidecar LLM finds a name it doesn't recognise and the new character popup is enabled, a dialog will ask: *"New character detected: [Name]. Create a profile?"* Confirming creates a blank entry with only the name filled in — no tokens are spent on generating details. You can fill it in manually or use the wand later.

### Character Display Screen

Selecting a character from the list opens their display, which shows:

- Name, source label, description, and notes (all editable)
- The full stat block across all three categories — click any category to expand per-stat commentary
- Dynamic title and narrative summary
- **◷ Clock icon** — toggles the update log showing the last 5 stat change entries, each with message range references, commentary, and rollback/delete options
- **✕ Delete** — removes the character profile entirely

### Update Log

Each log entry contains the complete before→after record for all 12 stats, including stats that did not change (logged as `0% → 0%` with an explanation). This gives the stat LLM full narrative continuity when reviewing future scenes.

**Rollback** restores the character's stats to their state before that entry. **Delete** removes only that log entry.

---

## Scenes Tab

The Scenes tab lists all closed scenes chronologically. Each entry shows the scene number, message range, characters present, and status.

Expanding a scene reveals its **LLM summary** — the private notepad entry written by the stat LLM when the scene closed. This summary is:

- Editable by you at any time
- Used as reference context when the LLM reviews future scenes
- **Never injected into your main ST prompt** — your primary AI does not see these

Delete a scene to remove it and its summary entirely.

---

## Settings Reference

| Setting | Description | Default |
|---|---|---|
| Stat update LLM | Connection profile for scene review and stat generation | — |
| Sidecar detection LLM | Connection profile for character presence scanning | — |
| Auto-gen profile LLM | Connection profile for profile generation | — |
| Batch scan | One-time scan of full chat history to bootstrap characters, scenes, and stats | — |
| Scene summary prompt | Editable prompt controlling how the LLM writes scene summaries | See below |
| Stat change range | Min/max points a stat can shift per scene close | -5 to +5 |
| Scan frequency | Messages between sidecar detection calls | 5 |
| New character popup | Prompt on unknown character detection | On |
| Inject stat block | Auto-inject present characters' stats into system prompt | On |
| Inject character profile | Also inject name, description, notes | On |
| Injection format | Stats only / Stats + narrative | Stats + narrative |
| Injection placement | Position in system prompt | Above character card |

### Default Scene Summary Prompt

> Write a concise scene summary for internal reference. Include: key events, emotional turning points, characters present, and any significant relationship shifts. Keep it clinical and factual — this is a note for future analysis, not a narrative retelling.

This is the only user-editable prompt in RST. All other internal prompts are fixed to ensure consistent stat generation.

---

## Batch Scan

For long or pre-existing chats, the **Run batch scan** button in Settings will:

1. Scan your full chat history to detect scene boundaries and character names
2. Create blank character profiles for any unrecognised names
3. Generate an initial stat block per character based on the full history
4. Generate scene summaries for detected scenes

Batch scan runs once and does not compound — running it again on a chat that already has RST data will not overwrite or stack on top of existing records.

---

### Rate Limiting
 
Batch scan has built-in rate limiting and retry handling to avoid overwhelming your API provider during large scans. All values are configurable in Settings under the batch scan options:
 
| Setting | Description | Default |
|---|---|---|
| Requests per minute | Maximum LLM calls per minute during the scan | 10 |
| Max retries | How many times to retry a failed request before giving up | 3 |
| Base retry delay | Starting delay in milliseconds before the first retry (doubles on each subsequent attempt) | 1000ms |
| Per-scene delay | Additional pause between scene processing steps | 0ms |
| Inter-phase delay | Pause between major scan phases (detection → stat generation) | 0ms |
 
If you are on a provider with strict rate limits or a slower tier, increase the requests per minute limit downward and raise the base retry delay to give your provider more breathing room. If you are hitting 429 errors during a scan, lowering requests per minute is the first thing to adjust.

---

## Stat Structure Reference

Every character tracked by RST has exactly 12 stats across three fixed categories:

```
Platonic  — Trust, Openness, Support, Affection
Romantic  — Trust, Openness, Support, Affection
Sexual    — Trust, Openness, Support, Affection
```

All values are percentages and can be negative. Positive values display in green, negative in red, zero in grey.

Stats are bounded to [-100, 100]. Per-scene changes are bounded by your configured stat change range (default -5 to +5 per scene close).

Every stat change — including zero-change entries — is recorded in the update log with a written explanation. This ensures the stat LLM always has a complete narrative reference when reviewing the next scene.

---

## Data Storage

RST stores data in two places within SillyTavern:

- **Global extension settings** (`extension_settings.rst`) — your configuration, connection profiles, and preferences. Shared across all chats.
- **Per-chat metadata** (`chat_metadata.rst`) — character profiles, scenes, stat history, and pending updates. Specific to each chat file.

This means character profiles and relationship stats are tied to the chat they were built in. Use the **Export** and **Import** options in the Character Library or Settings to move data between chats.

---

## Import / Export

- **Character Library → Export** — saves all character profiles for the current chat as a JSON file
- **Character Library → Import** — imports character profiles, validating each entry before committing
- **Settings → Export all / Import all** — saves or restores your full RST configuration including settings

---

## Tips

- Use a fast local model for the sidecar detection role — it runs frequently and only needs to return a list of names
- The stat update LLM benefits from being your strongest available model — it needs to reason about emotional context, narrative arc, and relationship dynamics
- Scene summaries are your LLM's memory between sessions. If something important happens that you want the stat LLM to remember, you can edit the summary directly in the Scenes tab
- Stats can go negative — this is intentional. A character can have genuinely negative affection, openness, or trust toward the user character
- The passive library reference (off by default in injection settings) lets the LLM passively know which characters exist even when they are not present in the current scene, at the cost of additional tokens per message

---

## Known Limitations (Beta)

- Slash command support is currently a placeholder and will be implemented in a future update
- Batch scan performance on very long chats depends on your stat update LLM's context window
- Character profiles are stored per-chat — a character appearing across multiple chat files will need separate profiles in each

---

## Version

**0.1.0** — Beta release  
Author: ExtensionMuncher
