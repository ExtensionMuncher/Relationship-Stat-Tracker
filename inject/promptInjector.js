/**
 * promptInjector.js — System prompt injection/removal of stat blocks
 * Injects character relationship stats into the ST system prompt
 */

import { setExtensionPrompt } from "../../../../../script.js";
import { getSettings, getPresentCharacters } from "../data/storage.js";
import { getCharacterProfile, STAT_CATEGORIES, STAT_NAMES } from "../data/characters.js";

// ─── Constants ────────────────────────────────────────────

const PROMPT_ID = "rst-stat-block";

// ST extension prompt roles
const ROLE_SYSTEM = 0;

// Placement mapping to ST's injection depth
const PLACEMENT_MAP = {
    above_card: 1,
    below_card: 2,
    top: 0,
    bottom: 100,
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

    const content = buildStatBlock(presentCharIds, settings);
    if (!content) {
        removeInjection();
        return;
    }

    const position = PLACEMENT_MAP[settings.injection.placement] || 1;

    setExtensionPrompt(PROMPT_ID, content, position, ROLE_SYSTEM);
}

/**
 * Remove the injected stat block from the system prompt.
 */
export function removeInjection() {
    setExtensionPrompt(PROMPT_ID, "", 0, ROLE_SYSTEM);
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
