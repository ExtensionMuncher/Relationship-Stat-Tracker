/**
 * promptInjector.js — System prompt injection/removal of stat blocks
 * Injects character relationship stats into the ST system prompt using markdown formatting.
 * Also manages passive library reference (lightweight character name directory).
 * injectionFilter pattern adapted from timeline-memory's updateTimelineInjection().
 */
 
import { setExtensionPrompt } from "../../../../../script.js";
import { getSettings, getPresentCharacters } from "../data/storage.js";
import { getCharacterProfile, getAllCharacters, STAT_CATEGORIES, STAT_NAMES } from "../data/characters.js";

// ─── Constants ────────────────────────────────────────────

const PROMPT_ID = "rst-stat-block";
const LIBRARY_REF_KEY = "rst-library-reference";

/**
 * Preview keys — ALWAYS injected at IN_PROMPT (position 0).
 * ST's Prompt section inspect view only shows extension prompts that are
 * in the system prompt collection (IN_PROMPT or BEFORE_PROMPT).  IN_CHAT
 * prompts are excluded.  To make RST's content visible in the Prompt
 * section preview (the same way Author's Note appears), we register
 * second entries at IN_PROMPT.  This follows ST's own dual-registration
 * pattern used by Author's Note.
 */
const PROMPT_PREVIEW_KEY = "rst-stat-block-preview";
const LIBRARY_PREVIEW_KEY = "rst-library-reference-preview";

// ST extension prompt roles
const ROLE_SYSTEM = 0;
const POSITION_IN_CHAT = 1;
const POSITION_IN_PROMPT = 0;

// Internal generation flag — prevents self-injection during RST's own API calls
let _isRSTInternalGen = false;

/**
 * Set the internal generation flag to prevent passive library reference from injecting
 * during RST's own LLM API calls (batch scan, stat update, profile gen, etc.).
 * @param {boolean} val
 */
export function setRSTInternalGen(val) {
    _isRSTInternalGen = val;
}

/**
 * Injection filter callback — returns false (suppress injection) during RST internal API calls.
 * Pattern matches timeline-memory's shouldInjectTimeline() approach.
 * @returns {boolean}
 */
function libraryRefFilter() {
    return !_isRSTInternalGen;
}

// Placement mapping to ST's injection position/depth
// Only ST-standard positions: top(0), above character card(1), below character card(2)
const PLACEMENT_MAP = {
    above_card: 1,
    below_card: 2,
    top: 0,
};

// ─── Main Injection Function ──────────────────────────────

/**
 * Update the injected stat block in the system prompt.
 * Called whenever present characters change or stats are updated.
 */
export function updateInjection() {
    const settings = getSettings();
    if (!settings.enabled || !settings.injection.injectStats) {
        removeInjection();
        return;
    }

    const presentCharIds = getPresentCharacters();
    if (presentCharIds.length === 0) {
        removeInjection();
        return;
    }

    // Active stat block for present characters
    const content = buildStatBlock(presentCharIds, settings);
    if (!content) {
        removeInjection();
        return;
    }

    const position = PLACEMENT_MAP[settings.injection.placement] || 1;
    setExtensionPrompt(PROMPT_ID, content, position, 0, false, ROLE_SYSTEM);

    // Preview key — always at IN_PROMPT so stat block content is visible
    // in the Prompt section inspect view (under Main Prompt), the same way
    // Author's Note appears there.
    setExtensionPrompt(PROMPT_PREVIEW_KEY, content, POSITION_IN_PROMPT, 0, false, ROLE_SYSTEM);

    // Passive library reference for ALL characters
    updatePassiveLibraryRef();
}

/**
 * Remove the injected stat block from the system prompt.
 */
export function removeInjection() {
    setExtensionPrompt(PROMPT_ID, "", 0, 0, false, ROLE_SYSTEM);
    setExtensionPrompt(PROMPT_PREVIEW_KEY, "", 0, 0, false, ROLE_SYSTEM);
    setExtensionPrompt(LIBRARY_REF_KEY, "", 0, 0, false, ROLE_SYSTEM);
    setExtensionPrompt(LIBRARY_PREVIEW_KEY, "", 0, 0, false, ROLE_SYSTEM);
}

// ─── Passive Library Reference ────────────────────────────

/**
 * Inject a lightweight passive reference directory (character names only)
 * so the main LLM knows which characters exist without burning tokens on
 * full stat dumps for irrelevant characters. Active stat blocks for
 * present characters already provide full data via buildStatBlock().
 * Pattern adapted from timeline-memory's updateTimelineInjection().
 */
export function updatePassiveLibraryRef() {
    const settings = getSettings();
    if (!settings.enabled || !settings.injection.passiveLibraryRef) {
        setExtensionPrompt(LIBRARY_REF_KEY, "", 0, 0, false, ROLE_SYSTEM);
        setExtensionPrompt(LIBRARY_PREVIEW_KEY, "", 0, 0, false, ROLE_SYSTEM);
        return;
    }

    const allChars = getAllCharacters();
    if (allChars.length === 0) {
        setExtensionPrompt(LIBRARY_REF_KEY, "", 0, 0, false, ROLE_SYSTEM);
        setExtensionPrompt(LIBRARY_PREVIEW_KEY, "", 0, 0, false, ROLE_SYSTEM);
        return;
    }

    const block = buildLibraryBlock(allChars);
    if (!block) {
        setExtensionPrompt(LIBRARY_REF_KEY, "", 0, 0, false, ROLE_SYSTEM);
        setExtensionPrompt(LIBRARY_PREVIEW_KEY, "", 0, 0, false, ROLE_SYSTEM);
        return;
    }

    const depth = settings.injection.libraryRefDepth ?? 2;

    // Map role string from settings to ST role number
    const roleMap = { system: 0, user: 1, assistant: 2 };
    const roleStr = settings.injection.libraryRefRole || "system";
    const role = roleMap[roleStr] ?? 0;

    // IN_CHAT position at configurable depth, configurable role, no WI scan, with injection filter
    // Filter prevents the library block from being injected during RST's own API calls
    setExtensionPrompt(LIBRARY_REF_KEY, block, POSITION_IN_CHAT, depth, false, role, libraryRefFilter);

    // Preview key — always at IN_PROMPT so library reference content is visible
    // in the Prompt section inspect view.
    setExtensionPrompt(LIBRARY_PREVIEW_KEY, block, POSITION_IN_PROMPT, 0, false, ROLE_SYSTEM);
}

/**
 * Build a lightweight passive reference directory with character names only.
 * This is intentionally minimal to avoid burning tokens on full stat dumps
 * for characters not present in the current scene. The LLM can reference
 * any character by name naturally as the conversation evolves.
 * @param {Array} allChars - All character profiles
 * @returns {string}
 */
function buildLibraryBlock(allChars) {
    const parts = [];

    parts.push("--- Relationship Library (Reference) ---");
    parts.push("The following characters have tracked relationship data. The LLM may reference any character by name when relevant to the conversation.");
    parts.push("");

    for (const profile of allChars) {
        if (!profile.name) continue;
        const name = profile.name;
        const desc = (typeof profile.description === "string" && profile.description)
            ? ` — ${profile.description.substring(0, 120)}`
            : "";
        parts.push(`- ${name}${desc}`);
    }

    parts.push("");
    parts.push("---");
    return parts.join("\n");
}

// ─── Stat Block Builder ───────────────────────────────────

/**
 * Build the stat block text for injection using markdown-friendly dividers.
 * @param {Array<string>} charIds - Present character IDs
 * @param {object} settings
 * @returns {string}
 */
function buildStatBlock(charIds, settings) {
    const blocks = [];

    for (const charId of charIds) {
        const profile = getCharacterProfile(charId);
        if (!profile) continue;

        const block = buildCharacterBlock(profile, settings);
        if (block) blocks.push(block);
    }

    if (blocks.length === 0) return "";

    const header = "--- Relationship Stats ---";
    const footer = "---";

    return `${header}\n\n${blocks.join("\n\n")}\n\n${footer}`;
}

/**
 * Build a single character's stat block for injection using markdown format.
 * Markdown structure (# headers, ### subheaders) is always present regardless of settings.
 * Content inside varies by format and injectProfile settings.
 * @param {object} profile
 * @param {object} settings
 * @returns {string}
 */
export function buildCharacterBlock(profile, settings) {
    const parts = [];

    // ── Header (always markdown) ──────────────────────────
    parts.push(`# Relationship Stats: ${profile.name} → {{user}}`);
    parts.push("");

    // ── Optional profile injection ────────────────────────
    // Per-character opt-out (eyeball toggle): Description and Notes can each be
    // independently hidden from the main AI, avoiding redundancy with an ST
    // character card whose personality is already in context.
    if (settings.injection.injectProfile) {
        const showDesc = profile.description && !profile.suppressDescriptionInjection;
        const showNotes = profile.notes && !profile.suppressNotesInjection;
        if (showDesc) {
            parts.push(`- **Description:** ${profile.description}`);
        }
        if (showNotes) {
            parts.push(`- **Notes:** ${profile.notes}`);
        }
        if (showDesc || showNotes) {
            parts.push("");
        }
    }

    // ── Stats (always markdown subheaders) ────────────────
    const format = settings.injection.format || "stats_and_narrative";

    // Get latest commentary from the most recent updateLog entry (if any)
    const latestLog = profile.updateLog && profile.updateLog.length > 0
        ? profile.updateLog[profile.updateLog.length - 1]
        : null;
    const commentary = latestLog?.commentary || {};

    for (const cat of STAT_CATEGORIES) {
        const catTitle = cat.charAt(0).toUpperCase() + cat.slice(1);
        const stats = profile.stats[cat] || {};
        const catCommentary = commentary[cat] || {};

        parts.push(`### ${catTitle}`);

        for (const stat of STAT_NAMES) {
            const val = stats[stat] ?? 0;
            const sign = val >= 0 ? "+" : "";
            const displayVal = `${sign}${val}%`;

            // Capitalize stat name for display
            const statLabel = stat.charAt(0).toUpperCase() + stat.slice(1);

            // Commentary available only when format is stats_and_narrative
            const comm = catCommentary[stat];
            if (format === "stats_and_narrative" && comm) {
                parts.push(`- ${statLabel}: ${displayVal} — ${comm}`);
            } else {
                parts.push(`- ${statLabel}: ${displayVal}`);
            }
        }

        parts.push("");
    }

    // ── Narrative (only when format includes it) ──────────
    if (format === "stats_and_narrative") {
        if (profile.dynamicTitle) {
            parts.push(`- **Dynamic Title:** ${profile.dynamicTitle}`);
        }
        if (profile.narrativeSummary) {
            parts.push(`- **Narrative Summary:** ${profile.narrativeSummary}`);
        }
    }

    return parts.join("\n").trim();
}

