/**
 * llm/statTool.js — Relationship stat lookup function tool
 *
 * Registers a `lookup_relationship_stats` tool with ST's ToolManager, following
 * the same pattern Memory Loom uses for `search_core_memories` and
 * timeline-memory uses for `query_timeline_chapter`. The MAIN chat LLM calls
 * this mid-generation when it needs a character's relationship stats but that
 * character is NOT currently present in the scene (and so was not auto-injected).
 *
 * Why this exists:
 *   - Passive injection only covers characters the sidecar detects as present.
 *   - Sometimes the narrative references an absent character ("Alex wonders
 *     how Sam feels about them now") and the model needs that character's
 *     current stats to stay consistent.
 *   - Rather than injecting the entire library every message (expensive), the
 *     model deliberately asks for one character on demand.
 *
 * The returned block uses the exact same markdown format as the passive
 * injection (buildCharacterBlock), so the model sees stats in a familiar shape.
 *
 * Requires a Chat Completion backend with function calling support and ST's
 * tool calling enabled.
 */

import { isEnabled, getSetting } from "../settings.js";
import { getSettings } from "../data/storage.js";
import {
    findCharacterByName,
    findCharacterBySimilarName,
    getAllCharacters,
} from "../data/characters.js";
import { buildCharacterBlock } from "../inject/promptInjector.js";

const TOOL_NAME = "lookup_relationship_stats";

export function registerStatLookupTool() {
    let ToolManager;
    try {
        ToolManager = window.SillyTavern?.getContext()?.ToolManager;
    } catch (e) { /* fall through */ }
    if (!ToolManager?.registerFunctionTool) {
        console.warn("[RST] Stat tool: ToolManager unavailable — ST version may not support function tools");
        return;
    }

    // Clear a stale definition before re-registering (timeline-memory pattern)
    try { ToolManager.unregisterFunctionTool(TOOL_NAME); } catch (e) {}

    ToolManager.registerFunctionTool({
        name: TOOL_NAME,
        displayName: "Look Up Relationship Stats",
        description: "Look up a character's current relationship stats toward the user, even if that character is not present in the current scene. Use when the narrative references a character who isn't on-screen and you need their trust, openness, support, or affection values to stay consistent. Returns the full relationship matrix (Platonic, Romantic, Sexual) plus any narrative summary.",
        stealth: false,
        parameters: {
            type: "object",
            properties: {
                character: {
                    type: "string",
                    description: "The full name of the character whose relationship stats you want to look up (e.g. 'Jane Doe'). Aliases and partial names are matched where possible.",
                },
            },
            required: ["character"],
        },
        action: async (args) => {
            try {
                return await lookupStats(args?.character || "");
            } catch (err) {
                console.error("[RST] Stat tool error:", err);
                return "Relationship stat lookup failed — the character library could not be reached.";
            }
        },
        shouldRegister: () => isEnabled() && getSetting("injection.statToolEnabled", true),
        formatMessage: (args) => `Looking up relationship stats for: "${args?.character || ""}"`,
    });

    console.log("[RST] Stat lookup tool registered: lookup_relationship_stats");
}

/**
 * Resolve a character by name (exact → alias-aware → fuzzy) and return their
 * stat block in the same markdown format used for passive injection.
 */
async function lookupStats(characterName) {
    const name = String(characterName || "").trim();
    if (!name) return "No character name was provided.";

    const all = getAllCharacters();
    if (!all || all.length === 0) {
        return "The character library is empty — no characters exist yet.";
    }

    // Exact / alias match first, then fuzzy fallback (same resolution order
    // the sidecar uses when detecting characters).
    let profile = findCharacterByName(name);
    if (!profile) profile = findCharacterBySimilarName(name);

    if (!profile) {
        const known = all.map(c => c.name).filter(Boolean).join(", ");
        return `No character named "${name}" was found in the library. Known characters: ${known || "(none)"}.`;
    }

    // Reuse the exact passive-injection formatter so the model sees a familiar
    // shape. Force stats_and_narrative so a deliberate lookup always returns the
    // full picture regardless of the injection format setting.
    const settings = getSettings();
    const lookupSettings = {
        ...settings,
        injection: {
            ...settings.injection,
            format: "stats_and_narrative",
            injectProfile: true,
        },
    };

    const block = buildCharacterBlock(profile, lookupSettings);
    if (!block) {
        return `${profile.name} exists in the library but has no stat data yet.`;
    }

    return block;
}
