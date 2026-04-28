/**
 * promptInjector.js — System prompt injection/removal of stat blocks
 * Injects character relationship stats into the ST system prompt
 * Also manages passive library reference for ALL characters
 * injectionFilter pattern adapted from timeline-memory's updateTimelineInjection()
 */

import { setExtensionPrompt, extension_prompt_roles } from "../../../../../script.js";
import { getSettings, getPresentCharacters } from "../data/storage.js";
import { getCharacterProfile, getAllCharacters, STAT_CATEGORIES, STAT_NAMES } from "../data/characters.js";

// ─── Constants ────────────────────────────────────────────

const PROMPT_ID = "rst-stat-block";
const LIBRARY_REF_KEY = "rst-library-reference";

// ST extension prompt roles
const ROLE_SYSTEM = 0;
const POSITION_IN_CHAT = 1;

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

    // Passive library reference for ALL characters
    updatePassiveLibraryRef();
}

/**
 * Remove the injected stat block from the system prompt.
 */
export function removeInjection() {
    setExtensionPrompt(PROMPT_ID, "", 0, 0, false, ROLE_SYSTEM);
    setExtensionPrompt(LIBRARY_REF_KEY, "", 0, 0, false, ROLE_SYSTEM);
}

// ─── Passive Library Reference ────────────────────────────

/**
 * Inject a passive reference block containing ALL character stats
 * so the main LLM can access any character's relationship data.
 * Pattern adapted from timeline-memory's updateTimelineInjection().
 */
export function updatePassiveLibraryRef() {
    const settings = getSettings();
    if (!settings.enabled || !settings.injection.passiveLibraryRef) {
        setExtensionPrompt(LIBRARY_REF_KEY, "", 0, 0, false, ROLE_SYSTEM);
        return;
    }

    const allChars = getAllCharacters();
    if (allChars.length === 0) {
        setExtensionPrompt(LIBRARY_REF_KEY, "", 0, 0, false, ROLE_SYSTEM);
        return;
    }

    const block = buildLibraryBlock(allChars, settings);
    const depth = settings.injection.libraryRefDepth ?? 2;

    // Map role string from settings to ST role number
    const roleMap = { system: 0, user: 1, assistant: 2 };
    const roleStr = settings.injection.libraryRefRole || "system";
    const role = roleMap[roleStr] ?? 0;

    // IN_CHAT position at configurable depth, configurable role, no WI scan, with injection filter
    // Filter prevents the library block from being injected during RST's own API calls
    setExtensionPrompt(LIBRARY_REF_KEY, block, POSITION_IN_CHAT, depth, false, role, libraryRefFilter);
}

/**
 * Build a passive reference block with ALL character profiles and stats.
 * Perspective-annotated to clarify character → {{user}} direction.
 * @param {Array} allChars - All character profiles
 * @param {object} settings
 * @returns {string}
 */
function buildLibraryBlock(allChars, settings) {
    const parts = [];

    parts.push("=== RELATIONSHIP LIBRARY (Reference Directory) ===");
    parts.push("Below is a reference directory of all tracked characters and their current relationship data toward {{user}}. This information is available for the LLM to reference freely when relevant — it is not mandatory context and should be used naturally as the conversation evolves.");
    parts.push("");

    for (const profile of allChars) {
        parts.push(buildCharacterBlock(profile, settings));
        parts.push("");
    }

    parts.push("=== END RELATIONSHIP LIBRARY ===");
    return parts.join("\n");
}

// ─── Stat Block Builder ───────────────────────────────────

/**
 * Build the stat block text for injection.
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

    const header = "=== RELATIONSHIP STATE TRACKER ===";
    const footer = "=== END RELATIONSHIP STATE ===";

    return `${header}\n${blocks.join("\n\n")}\n${footer}`;
}

/**
 * Build a single character's stat block for injection.
 * @param {object} profile
 * @param {object} settings
 * @returns {string}
 */
function buildCharacterBlock(profile, settings) {
    const parts = [];

    // Character header
    parts.push(`[${profile.name}]`);

    // Optional profile injection
    if (settings.injection.injectProfile) {
        if (profile.description) {
            parts.push(`Description: ${profile.description}`);
        }
        if (profile.notes) {
            parts.push(`Notes: ${profile.notes}`);
        }
    }

    // Stats
    const format = settings.injection.format || "stats_and_narrative";

    for (const cat of STAT_CATEGORIES) {
        const catTitle = cat.charAt(0).toUpperCase() + cat.slice(1);
        const stats = profile.stats[cat];
        const statLines = STAT_NAMES.map((stat) => {
            const val = stats[stat];
            const sign = val >= 0 ? "+" : "";
            return `  ${stat}: ${sign}${val}%`;
        });
        parts.push(`${catTitle}:\n${statLines.join("\n")}`);
    }

    // Narrative (if format includes it)
    if (format === "stats_and_narrative") {
        if (profile.dynamicTitle) {
            parts.push(`Dynamic Title: ${profile.dynamicTitle}`);
        }
        if (profile.narrativeSummary) {
            parts.push(`Narrative: ${profile.narrativeSummary}`);
        }
    }

    return parts.join("\n");
}

