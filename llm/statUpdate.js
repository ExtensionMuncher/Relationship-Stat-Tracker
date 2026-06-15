/**
 * statUpdate.js — Main LLM: scene review + stat generation
 * Reviews closed scenes, generates stat changes, commentary, dynamic titles,
 * narrative summaries, AND scene summaries (single LLM call)
 */

import { chat } from "../../../../../script.js";
import { getContext } from "../../../../extensions.js";
import { makeRequest } from "./connections.js";
import { getSettings, getNameBlacklist } from "../data/storage.js";
import { getCharacterProfile, getAllCharacters, findCharacterByName, findCharacterByFuzzyName, getCharacterNameVariants, cloneStats, STAT_CATEGORIES, STAT_NAMES, createCharacter } from "../data/characters.js";
import { getSceneById, getAllSceneSummaries, updateSceneCharacters, updateSceneTitle } from "../data/scenes.js";
import { dlog } from "../lib/debug.js";

// ─── Auto-created Character Tracking ──────────────────────
// Tracks which character IDs were auto-created during a generation cycle
// so dismiss handlers can reliably clean them up without relying on
// heuristic checks like `source === "auto_generated"`.
/** @type {Set<string>} */
let _autoCreatedIds = new Set();

/**
 * Get the set of auto-created character IDs from the current generation cycle.
 * @returns {string[]}
 */
export function getAutoCreatedIds() {
    return [..._autoCreatedIds];
}

/**
 * Reset the auto-created IDs tracker for a new generation cycle.
 */
export function resetAutoCreatedIds() {
    _autoCreatedIds = new Set();
}

// ─── Main Generation Function ─────────────────────────────

/**
 * Generate stat updates for all characters present in a closed scene.
 * Handles both new characters (generates initial stats flexibly) and
 * existing characters (applies constrained stat changes).
 * @param {string} sceneId - The scene to review
 * @param {string} [guidance] - Optional user guidance for regeneration
 * @returns {Promise<object>} The full update result
 */
export async function generateStatUpdate(sceneId, guidance = "") {
    // Reset auto-created character tracker for this generation cycle
    resetAutoCreatedIds();

    const settings = getSettings();
    const scene = getSceneById(sceneId);
    if (!scene) throw new Error(`Scene ${sceneId} not found`);

    const profileName = settings.connections.statUpdateLLM;
    dlog("[RST] generateStatUpdate using profileName:", JSON.stringify(profileName), "sceneId:", sceneId);

    const sceneMessages = getSceneMessages(scene);
    const characters = getSceneCharacters(scene);
    const pastSummaries = getAllSceneSummaries();

    dlog("[RST] generateStatUpdate scene messages:", sceneMessages.length, "characters:", characters.length, "pastSummaries:", pastSummaries.length);

    if (characters.length === 0) {
        console.warn("[RST] No characters found in scene — cannot generate stat update");
        throw new Error("No characters found in scene");
    }

    try {
        // Separate characters into new (all stats at 0%) and existing
        const newChars = characters.filter((c) => isNewCharacter(c));
        const existingChars = characters.filter((c) => !isNewCharacter(c));

        dlog("[RST] New characters:", newChars.length, "Existing characters:", existingChars.length);

        let sceneSummary = "";
        let sceneTitle = "";
        let characterUpdates = [];

        // Handle new characters with flexible initial stat generation
        if (newChars.length > 0) {
            toastr?.info?.("Generating initial stats for new characters...");
            const initialResult = await generateInitialStatsForScene(
                sceneMessages, newChars, profileName, settings
            );
            sceneSummary = initialResult.sceneSummary || "";
            sceneTitle = initialResult.sceneTitle || "";
            characterUpdates = characterUpdates.concat(initialResult.characterUpdates || []);
        }

        // Handle existing characters with constrained stat update
        if (existingChars.length > 0) {
            toastr?.info?.("Generating stat updates...");
            const systemPrompt = buildStatUpdateSystemPrompt(settings);
            const requestPrompt = buildStatUpdateRequestPrompt(
                sceneMessages,
                existingChars,
                pastSummaries,
                settings,
                guidance
            );

            const resultText = await makeRequest(
                profileName,
                systemPrompt,
                requestPrompt,
                4000,
                0.3,
            );

            if (!resultText) throw new Error("No response from LLM");

            const parsed = parseStatUpdateResponse(resultText, existingChars);
            // Only use initial scene summary if no new chars generated one
            if (!sceneSummary) {
                sceneSummary = parsed.sceneSummary || "";
            }
            if (!sceneTitle) {
                sceneTitle = parsed.sceneTitle || "";
            }
            characterUpdates = characterUpdates.concat(parsed.characterUpdates || []);
        }

        // If only new characters existed and they generated the scene summary,
        // we already have it. Otherwise ensure we have one.
        if (!sceneSummary && characterUpdates.length > 0) {
            // Try generating a minimal summary from the first character's data
            // or create a placeholder
            sceneSummary = "Scene reviewed for initial character stat generation.";
        }

        return {
            sceneId,
            sceneSummary,
            sceneTitle,
            summaryGuidance: guidance,
            characterUpdates,
            autoCreatedIds: getAutoCreatedIds(),
        };
    } catch (err) {
        console.error("[RST] Stat update generation failed:", err);
        toastr?.error?.("Stat update generation failed. Please try again.");
        throw err;
    }
}

// ─── Prompt Building ──────────────────────────────────────

/**
 * Build the system prompt for the stat update LLM.
 * @param {object} settings
 * @returns {string}
 */
function buildStatUpdateSystemPrompt(settings) {
    const range = settings.statChangeRange || { min: -5, max: 5 };

    return [
        'You are a relationship stat update generator.',
        'Output ONLY a JSON object.',
        '',
        'Schema:',
        '  {',
        '    "sceneTitle": "...",',
        '    "sceneSummary": "...",',
        '    "characters": {',
        '      "[NAME]": {',
        '        "stats": {',
        '          "platonic": {"trust":-100-100,"openness":-100-100,"support":-100-100,"affection":-100-100},',
        '          "romantic": {"trust":-100-100,"openness":-100-100,"support":-100-100,"affection":-100-100},',
        '          "sexual": {"trust":-100-100,"openness":-100-100,"support":-100-100,"affection":-100-100}',
        '        },',
        '        "commentary": {',
        '          "platonic": {"trust":"reason","openness":"reason","support":"reason","affection":"reason"},',
        '          "romantic": {"trust":"reason","openness":"reason","support":"reason","affection":"reason"},',
        '          "sexual": {"trust":"reason","openness":"reason","support":"reason","affection":"reason"}',
        '        },',
        '        "dynamicTitle": "...",',
        '        "milestoneReached": false,',
        '        "milestoneDetail": "...",',
        '        "narrativeSummary": "..."',
        '      }',
        '    }',
        '  }',
        '',
        'Rules:',
        '- Stats represent character\'s feelings toward {{user}}, not reverse.',
        '- Range: -100 to 100. 0 = neutral.',
        `- Each stat MUST stay within ${range.min} to ${range.max} points of its current (pre-scene) value. For example, if Trust is currently 30 and the range is -5 to +5, the new Trust must be between 25 and 35.`,
        '- Stats are ABSOLUTE values (not deltas), but each must respect the per-scene change limit above.',
        '- Commentary: provide a brief narrative explanation for each stat (describe WHY this character feels this way based on scene events). Do NOT describe how much a stat changed numerically.',
        '- Milestone: all four elements in a category cross 25/50/75/100%.',
    ].join('\n');
}

/**
 * Build the request prompt with scene data.
 * @param {Array} messages - Scene messages
 * @param {Array} characters - Character profiles in the scene
 * @param {Array} pastSummaries - Previous scene summaries
 * @param {object} settings
 * @param {string} guidance
 * @returns {string}
 */
function buildStatUpdateRequestPrompt(messages, characters, pastSummaries, settings, guidance) {
    const parts = [];

    // Scene summary prompt
    parts.push(`SCENE SUMMARY INSTRUCTIONS:\n${settings.sceneSummaryPrompt || ""}`);

    // Past context
    if (pastSummaries.length > 0) {
        parts.push("PAST SCENE SUMMARIES (for continuity):");
        pastSummaries.forEach((s) => {
            parts.push(`[${s.id}]: ${s.summary}`);
        });
    }

    // Current character stats
    parts.push("\nCURRENT CHARACTER STATS (character → {{user}} perspective):");
    for (const char of characters) {
        const aliases = getCharacterNameVariants(char).filter(a => a !== char.name.toLowerCase().trim());
        const aliasStr = aliases.length > 0 ? ` (also known as: ${aliases.join(", ")})` : "";
        parts.push(`\n${char.name}${aliasStr}:`);
        parts.push(`  Current dynamic title: "${char.dynamicTitle || "None"}"`);
        parts.push(`  Current narrative: "${char.narrativeSummary || "None"}"`);
        parts.push(`  Stats:`);
        for (const cat of STAT_CATEGORIES) {
            const stats = char.stats[cat];
            parts.push(`    ${cat}: trust=${stats.trust}%, openness=${stats.openness}%, support=${stats.support}%, affection=${stats.affection}%`);
        }
    }

    // Scene messages
    const userName = getContext().name1 || "User";
    parts.push(`\nSCENE MESSAGES ("${userName}" is the user/player, all other named speakers are characters):`);
    messages.forEach((m, i) => {
        const speaker = m.name || "Unknown";
        const text = m.mes || "";
        const isUser = m.is_user ? " [USER]" : "";
        parts.push(`[${i}]${isUser} ${speaker}: ${text}`);
    });

    // Optional guidance
    if (guidance) {
        parts.push(`\nUSER GUIDANCE: ${guidance}`);
    }

    // Character discovery instruction — be INCLUSIVE by default
    parts.push('');
    parts.push('CRITICAL — Scan for ALL additional characters:');
    parts.push('- You MUST identify EVERY named individual who appears, speaks, interacts, or is described as doing something in the scene messages.');
    parts.push('- INCLUDE characters who: speak dialogue, are addressed by name, perform actions described by another speaker, interact with someone in the scene, or are described as being physically present or doing an activity.');
    parts.push('- Example of INCLUDE: a character says "I talked with [Name]" or "[Name] handed me the package" or "[Name] and I went to the store" — [Name] is described as interacting and should be included.');
    parts.push('- Example of EXCLUDE: "I heard about [Name]\'s reputation" or "someone mentioned [Name] is tall" — [Name] is merely discussed with no described interaction.');
    parts.push('- When in doubt, INCLUDE the character. It is better to include a character unnecessarily than to miss someone.');
    parts.push('Include them in your characters object with full stat updates using the same schema.');
    parts.push('');

    // Force JSON-only output
    parts.push('Return JSON only.');

    return parts.join("\n");
}

// ─── Response Parsing ─────────────────────────────────────

/**
 * Parse the LLM response into structured update data.
 * @param {string} response - Raw LLM output
 * @param {Array} characters - Character profiles
 * @returns {{sceneSummary: string, characterUpdates: Array}}
 */
function parseStatUpdateResponse(response, characters) {
    // Try primary JSON extraction
    let parsed = extractJsonFromResponse(response);

    // If JSON extraction failed, try analysis-text fallback parser
    if (!parsed) {
        const fallbackResult = parseStatUpdateAnalysisText(response, characters);
        if (fallbackResult) {
            dlog("[RST] Parsed stat update response using analysis-text fallback");
            return fallbackResult;
        }
    }

    if (!parsed) {
        const partial = extractPartialData(response);
        const preview = (response || "").substring(0, 150);
        console.warn(`[RST] Failed to parse stat update response. Preview: "${preview}"`, { partial });
        throw new Error("Failed to parse stat update response as JSON. Response may be truncated — try increasing max tokens.");
    }

    const sceneSummary = parsed.sceneSummary || "";
    const sceneTitle = parsed.sceneTitle || "";
    const characterUpdates = [];

    for (const char of characters) {
        // Try exact canonical name first, then alias variants, then fuzzy match
        let charData = parsed.characters?.[char.name];
        if (!charData && char.nameAliases && Array.isArray(char.nameAliases)) {
            for (const alias of char.nameAliases) {
                charData = parsed.characters?.[alias];
                if (charData) break;
            }
        }
        if (!charData) {
            // Try fuzzy match: find which key in parsed.characters matches this character
            for (const [llmKey] of Object.entries(parsed.characters || {})) {
                const matched = findCharacterByFuzzyName(llmKey);
                if (matched && matched.id === char.id) {
                    charData = parsed.characters[llmKey];
                    break;
                }
            }
        }
        if (!charData) {
            // Character not found in LLM response — create a no-change entry
            characterUpdates.push(createNoChangeEntry(char));
            continue;
        }

        const statsBefore = cloneStats(char.stats);
        const settings = getSettings();
        const range = settings.statChangeRange || { min: -5, max: 5 };
        // Merge LLM stats over existing stats so unmentioned ones don't default to 0
        const mergedStats = mergeWithExistingStats(statsBefore, charData.stats || {});
        const statsAfter = applyDeltaRange(statsBefore, clampStats(mergedStats), range);
        // Use LLM commentary if provided, otherwise generate fallback
        // Pass char to preserve old commentary for unchanged stats
        let commentary = charData.commentary || null;
        if (!commentary || hasEmptyCommentary(commentary)) {
            commentary = generateFallbackCommentary(statsBefore, statsAfter, char);
        } else {
            commentary = fillMissingCommentary(commentary, statsBefore, statsAfter, char);
        }

        // Count actual changes
        const changeCount = countChanges(statsBefore, statsAfter);

        characterUpdates.push({
            characterId: char.id,
            characterName: char.name,
            statsBefore,
            statsAfter,
            commentary,
            dynamicTitleBefore: char.dynamicTitle || "",
            dynamicTitleAfter: charData.dynamicTitle || char.dynamicTitle || "",
            milestoneReached: charData.milestoneReached || false,
            milestoneDetail: charData.milestoneDetail || "",
            narrativeSummary: charData.narrativeSummary || char.narrativeSummary || "",
            source: "llm",
            changeCount,
        });
    }

    // Handle LLM-discovered characters (in parsed.characters but not in input list)
    if (parsed && parsed.characters) {
        const inputNames = new Set(characters.map(c => c.name));
        const allKnownChars = getAllCharacters();
        for (const [llmName, llmData] of Object.entries(parsed.characters)) {
            if (!inputNames.has(llmName) && llmData && llmData.stats) {
                const lowerLlmName = llmName.toLowerCase().trim();
                // Check if this LLM name matches an existing character (by alias, exact name, or fuzzy word match)
                const matchedExisting = allKnownChars.find(c => {
                    if (c.name.toLowerCase().trim() === lowerLlmName) return true;
                    if (c.nameAliases && Array.isArray(c.nameAliases)) {
                        if (c.nameAliases.some(a => a.toLowerCase().trim() === lowerLlmName)) return true;
                    }
                    const cWords = c.name.toLowerCase().trim().split(/\s+/).filter(Boolean).sort().join(" ");
                    const llmWords = lowerLlmName.split(/\s+/).filter(Boolean).sort().join(" ");
                    return cWords === llmWords;
                });
                if (matchedExisting) {
                    // Name matches existing character — create update entry instead of duplicate
                    dlog(`[RST] LLM name "${llmName}" matches existing character "${matchedExisting.name}" — creating update entry`);
                    const statsBefore = cloneStats(matchedExisting.stats);
                    const settings = getSettings();
                    const range = settings.statChangeRange || { min: -5, max: 5 };
                    // Merge LLM stats over existing stats so unmentioned ones don't default to 0
                    const mergedStats = mergeWithExistingStats(statsBefore, llmData.stats || {});
                    const statsAfter = applyDeltaRange(statsBefore, clampStats(mergedStats), range);
                    let commentary = llmData.commentary || null;
                    if (!commentary || hasEmptyCommentary(commentary)) {
                        commentary = generateFallbackCommentary(statsBefore, statsAfter, matchedExisting);
                    } else {
                        commentary = fillMissingCommentary(commentary, statsBefore, statsAfter, matchedExisting);
                    }
                    const changeCount = countChanges(statsBefore, statsAfter);
                    characterUpdates.push({
                        characterId: matchedExisting.id,
                        characterName: matchedExisting.name,
                        statsBefore,
                        statsAfter,
                        commentary,
                        dynamicTitleBefore: matchedExisting.dynamicTitle || "",
                        dynamicTitleAfter: llmData.dynamicTitle || matchedExisting.dynamicTitle || "",
                        milestoneReached: llmData.milestoneReached || false,
                        milestoneDetail: llmData.milestoneDetail || "",
                        narrativeSummary: llmData.narrativeSummary || matchedExisting.narrativeSummary || "",
                        source: "llm",
                        changeCount,
                    });
                } else {
                    // Truly new character — create new profile
                    dlog("[RST] LLM discovered additional character:", llmName);
                    const newChar = createCharacter(llmName, { source: "auto_generated" });
                    if (newChar) {
                        _autoCreatedIds.add(newChar.id);
                        const statsAfter = clampStats(llmData.stats);
                        let commentary = llmData.commentary || null;
                        if (!commentary || hasEmptyCommentary(commentary)) {
                            commentary = generateFallbackCommentary({}, statsAfter);
                        } else {
                            commentary = fillMissingCommentary(commentary, {}, statsAfter);
                        }
                        characterUpdates.push({
                            characterId: newChar.id,
                            characterName: newChar.name,
                            statsBefore: null,
                            statsAfter,
                            commentary,
                            dynamicTitleBefore: "",
                            dynamicTitleAfter: llmData.dynamicTitle || "",
                            milestoneReached: llmData.milestoneReached || false,
                            milestoneDetail: llmData.milestoneDetail || "",
                            narrativeSummary: llmData.narrativeSummary || "",
                            source: "llm_discovered",
                            changeCount: 12,
                        });
                    }
                }
            }
        }
    }

    return { sceneSummary, sceneTitle, characterUpdates };
}

// ─── JSON Extraction Helpers ──────────────────────────────

/**
 * Strip markdown code fences from LLM response text.
 * Handles ```json ... ```, ``` ... ```, and similar patterns.
 * @param {string} text
 * @returns {string}
 */
function stripCodeFences(text) {
    return text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
}

/**
 * Attempt to extract and parse JSON from an LLM response using a multi-strategy cascade.
 * Strategies (in order):
 *   1. Strip fences → direct JSON.parse
 *   2. Extract from ```json ... ``` block
 *   3. Extract from generic ``` ... ``` block
 *   4. Greedy regex: match first { to last }
 *   5. Progressive trim: try shortening from end
 *   6. Truncated JSON repair: try appending closing braces
 *   7. Return null (caller may try analysis-text fallback)
 * @param {string} response - Raw LLM response
 * @returns {object|null} Parsed JSON object, or null
 */
function extractJsonFromResponse(response) {
    if (!response || typeof response !== "string") return null;

    // Strategy 1: Strip code fences → direct parse
    let cleaned = stripCodeFences(response);
    try {
        return JSON.parse(cleaned);
    } catch (e1) {
        // Fall through
    }

    // Strategy 2: Extract from ```json ... ``` block
    const jsonFenceMatch = cleaned.match(/```json\s*([\s\S]*?)```/);
    if (jsonFenceMatch) {
        try {
            return JSON.parse(jsonFenceMatch[1].trim());
        } catch (e2) {
            // Fall through
        }
    }

    // Strategy 3: Extract from generic ``` ... ``` block
    const genericFenceMatch = cleaned.match(/```\s*([\s\S]*?)```/);
    if (genericFenceMatch) {
        try {
            return JSON.parse(genericFenceMatch[1].trim());
        } catch (e3) {
            // Fall through
        }
    }

    // Strategy 4: Greedy braces — match first { to last }
    const greedyMatch = cleaned.match(/\{[\s\S]*\}/);
    if (greedyMatch) {
        try {
            return JSON.parse(greedyMatch[0]);
        } catch (e4) {
            // Fall through
        }
    }

    // Strategy 5: Progressive trim — try removing trailing chars one by one
    const braceMatch = cleaned.match(/\{[\s\S]*\}/);
    if (braceMatch) {
        let candidate = braceMatch[0];
        for (let i = candidate.length - 1; i >= 1; i--) {
            try {
                return JSON.parse(candidate.substring(0, i));
            } catch {
                continue;
            }
        }
    }

    // Strategy 6: Truncated JSON repair — try appending closing braces
    if (braceMatch) {
        let candidate = braceMatch[0];
        for (let depth = 1; depth <= 10; depth++) {
            try {
                return JSON.parse(candidate + "}".repeat(depth));
            } catch {
                continue;
            }
        }
    }

    // Strategy 7: No closing brace — extract from { to end, attempt JSON repair
    const openBraceFallback = cleaned.match(/\{[\s\S]*/);
    if (openBraceFallback) {
        const repaired = repairTruncatedJson(openBraceFallback[0]);
        if (repaired) return repaired;
    }

    // Strategy 8: Return null — caller may try analysis-text fallback
    return null;
}

/**
 * Attempt to repair truncated JSON by balancing braces and closing unclosed strings.
 * Handles responses that are cut off mid-value (no closing brace).
 * @param {string} text - Partial JSON text starting from first {
 * @returns {object|null} Parsed object, or null if repair fails
 */
function repairTruncatedJson(text) {
    // Count braces and track string state to compute what needs closing
    let braceDepth = 0;
    let inString = false;
    let escaped = false;
    let lastValidEnd = -1;
    let lastValidDepth = 0;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\' && inString) { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') { braceDepth++; lastValidEnd = i; lastValidDepth = braceDepth; }
        if (ch === '}') { braceDepth--; lastValidEnd = i; lastValidDepth = braceDepth; }
    }

    // Determine what to close
    let repaired = text;
    if (inString) {
        // Truncated mid-string — close the string
        repaired += '"';
    }
    // Add closing braces to match open depth
    if (braceDepth > 0) {
        repaired += '}'.repeat(braceDepth);
    }

    try {
        return JSON.parse(repaired);
    } catch {
        // If repair failed, try progressive trim from end
        for (let i = repaired.length - 1; i >= 10; i--) {
            try {
                return JSON.parse(repaired.substring(0, i));
            } catch {
                continue;
            }
        }
        return null;
    }
}

/**
 * Parse GLM 4.7 analysis-text format for stat updates.
 * Handles numbered bullet-point format with * markers.
 * Example:
 *   1. **Character: Alice**
 *      * **Platonic:** trust=30, openness=20, support=10, affection=15
 *        * Commentary: trust: increased... openness: ...
 *      * **Romantic:** trust=10, openness=5, support=0, affection=8
 *      * **Dynamic Title:** The Loyal Companion
 *      * **Narrative Summary:** Alice shows growing trust...
 *   2. **Scene Title:** At the Crossroads
 *   3. **Scene Summary:** Alice and Bob...
 * @param {string} text - Raw LLM response
 * @param {Array} characters - Character profiles
 * @returns {{sceneSummary: string, sceneTitle: string, characterUpdates: Array}|null}
 */
function parseStatUpdateAnalysisText(text, characters) {
    if (!text || typeof text !== "string") return null;

    let sceneTitle = "";
    let sceneSummary = "";
    const charStatsMap = {};

    // Extract scene-level metadata
    const titleMatch = text.match(/\*\*Scene Title:\*\*\s*(.+)/i);
    if (titleMatch) sceneTitle = titleMatch[1].trim();

    const summaryMatch = text.match(/\*\*Scene Summary:\*\*\s*(.+)/i);
    if (summaryMatch) sceneSummary = summaryMatch[1].trim();

    // Split into character sections by looking for "**Character: NAME**" patterns
    const charSectionRegex = /\d+\.\s*\*\*Character:\s*([^*]+)\*\*/gi;
    let charMatch;
    const charSections = {};

    // Find the start indices of each character section
    const sectionStarts = [];
    const nameRegex = /\d+\.\s*\*\*Character:\s*([^*]+)\*\*/gi;
    let nameMatch;
    while ((nameMatch = nameRegex.exec(text)) !== null) {
        sectionStarts.push({
            name: nameMatch[1].trim(),
            index: nameMatch.index,
            endIndex: nameMatch.index + nameMatch[0].length,
        });
    }

    if (sectionStarts.length === 0) return null;

    // Extract text for each character section
    for (let i = 0; i < sectionStarts.length; i++) {
        const start = sectionStarts[i];
        const end = i + 1 < sectionStarts.length ? sectionStarts[i + 1].index : text.length;
        const sectionText = text.substring(start.index, end);
        charStatsMap[start.name] = sectionText;
    }

    // Also try to find Scene Title and Summary if not found at top level
    if (!sceneTitle || !sceneSummary) {
        for (const [charName, sectionText] of Object.entries(charStatsMap)) {
            // Check if scene metadata is nested inside character section
            const stMatch = sectionText.match(/\*\*Scene Title:\*\*\s*(.+)/i);
            if (stMatch && !sceneTitle) sceneTitle = stMatch[1].trim();
            const ssMatch = sectionText.match(/\*\*Scene Summary:\*\*\s*(.+)/i);
            if (ssMatch && !sceneSummary) sceneSummary = ssMatch[1].trim();
        }
    }

    // Parse each character's stats from their section
    const characterUpdates = [];
    const STAT_CATEGORIES_LOCAL = ["platonic", "romantic", "sexual"];
    const STAT_NAMES_LOCAL = ["trust", "openness", "support", "affection"];

    for (const char of characters) {
        const sectionText = charStatsMap[char.name];
        if (!sectionText) {
            characterUpdates.push(createNoChangeEntry(char));
            continue;
        }

        const statsAfter = {};
        let foundAnyStat = false;

        for (const cat of STAT_CATEGORIES_LOCAL) {
            statsAfter[cat] = {};
            // Match: * **Platonic:** trust=30, openness=20, ...
            const catRegex = new RegExp(`\\*\\*${cat}\\*\\*:\\s*([^*]*)`, "i");
            const catMatch = sectionText.match(catRegex);
            if (catMatch) {
                foundAnyStat = true;
                const statLine = catMatch[1];
                for (const stat of STAT_NAMES_LOCAL) {
                    const statRegex = new RegExp(`${stat}\\s*=\\s*(-?\\d+)`, "i");
                    const statMatch = statLine.match(statRegex);
                    if (statMatch) {
                        statsAfter[cat][stat] = Math.max(-100, Math.min(100, parseInt(statMatch[1], 10)));
                    }
                    // Don't default unmentioned stats to 0 — leave undefined
                    // so mergeWithExistingStats can preserve current values
                }
            }
            // Don't default missing categories — leave undefined
            // so mergeWithExistingStats preserves current values
        }

        if (!foundAnyStat) {
            characterUpdates.push(createNoChangeEntry(char));
            continue;
        }

        // Extract dynamic title from section
        const dtMatch = sectionText.match(/\*\*Dynamic Title:\*\*\s*(.+)/i);
        const dynamicTitleAfter = dtMatch ? dtMatch[1].trim() : "";

        // Extract narrative summary
        const nsMatch = sectionText.match(/\*\*Narrative Summary:\*\*\s*(.+)/i);
        const narrativeSummary = nsMatch ? nsMatch[1].trim() : "";

        // Extract commentary
        const commentary = {};
        const commSection = sectionText.match(/\*\*Commentary:\*\*\s*([\s\S]*?)(?=\n\s*\d+\.|\n\s*\*\*|$)/i);
        if (commSection) {
            const commText = commSection[1];
            for (const cat of STAT_CATEGORIES_LOCAL) {
                commentary[cat] = {};
                const catCommRegex = new RegExp(`${cat}\\s*[:-]\\s*([^\\n]*(?:\\n[^\\n*]+)*)`, "i");
                const catCommMatch = commText.match(catCommRegex);
                if (catCommMatch) {
                    const commStr = catCommMatch[1].trim();
                    for (const stat of STAT_NAMES_LOCAL) {
                        const statCommRegex = new RegExp(`${stat}\\s*[:-]\\s*([^,\\n]+)`, "i");
                        const statCommMatch = commStr.match(statCommRegex);
                        commentary[cat][stat] = statCommMatch ? statCommMatch[1].trim() : "Based on scene events.";
                    }
                } else {
                    commentary[cat] = { trust: "Based on scene events.", openness: "Based on scene events.", support: "Based on scene events.", affection: "Based on scene events." };
                }
            }
        } else {
            // Fallback commentary
            for (const cat of STAT_CATEGORIES_LOCAL) {
                commentary[cat] = {};
                for (const stat of STAT_NAMES_LOCAL) {
                    commentary[cat][stat] = "Based on scene events.";
                }
            }
        }

        const statsBefore = cloneStats(char.stats);
        const settings = getSettings();
        const range = settings.statChangeRange || { min: -5, max: 5 };
        // Merge analysis-text stats over existing stats so unmentioned ones don't default to 0
        const mergedStats = mergeWithExistingStats(statsBefore, statsAfter);
        const clampedAfter = applyDeltaRange(statsBefore, clampStats(mergedStats), range);
        // Preserve old commentary for unchanged stats via fillMissingCommentary
        const filledCommentary = fillMissingCommentary(commentary, statsBefore, clampedAfter, char);

        characterUpdates.push({
            characterId: char.id,
            characterName: char.name,
            statsBefore,
            statsAfter: clampedAfter,
            commentary: filledCommentary,
            dynamicTitleBefore: char.dynamicTitle || "",
            dynamicTitleAfter,
            milestoneReached: false,
            milestoneDetail: "",
            narrativeSummary: narrativeSummary || char.narrativeSummary || "",
            source: "llm_fallback",
            changeCount: countChanges(statsBefore, clampedAfter),
        });
    }

    return { sceneSummary, sceneTitle, characterUpdates };
}

/**
 * Extract partial data (sceneTitle, sceneSummary) from a truncated/invalid JSON response.
 * Used as a last resort when full JSON parsing fails.
 * @param {string} response - Raw LLM response text
 * @returns {{sceneSummary: string, sceneTitle: string}}
 */
function extractPartialData(response) {
    const result = { sceneSummary: "", sceneTitle: "" };

    const titleMatch = response.match(/"sceneTitle"\s*:\s*"([^"]+)"/);
    if (titleMatch) result.sceneTitle = titleMatch[1];

    const summaryMatch = response.match(/"sceneSummary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (summaryMatch) result.sceneSummary = summaryMatch[1];

    return result;
}

/**
 * Get messages within a scene's range.
 * @param {object} scene
 * @returns {Array}
 */
function getSceneMessages(scene) {
    if (!chat || !Array.isArray(chat)) return [];
    const start = scene.messageStart || 0;
    const end = scene.messageEnd !== null ? scene.messageEnd + 1 : chat.length;
    return chat.slice(start, end);
}

/**
 * Get character profiles for all characters present in a scene.
 * @param {object} scene
 * @returns {Array}
 */
function getSceneCharacters(scene) {
    const sceneMessages = getSceneMessages(scene);
    const allKnownChars = getAllCharacters();
    const foundIds = new Set();
    const unknownSpeakers = new Set();

    // Build exclusion set: persona name + settings blacklist
    const settings = getSettings();
    const personaName = (getContext().name1 || "").toLowerCase().trim();
    const blacklistNames = (getNameBlacklist() || []).map((n) => n.toLowerCase().trim()).filter(Boolean);
    const excludedNames = new Set(["{{user}}", "user", "User", personaName, ...blacklistNames]);

    // Helper: check if a name is excluded
    function isExcluded(name) {
        const n = (name || "").toLowerCase().trim();
        return !n || excludedNames.has(n);
    }

    // Step 1: Collect any characters already registered on the scene
    const charIds = scene.charactersPresent || [];
    for (const id of charIds) {
        const profile = getCharacterProfile(id);
        if (profile && !isExcluded(profile.name)) foundIds.add(id);
    }

    // Step 2: Detect multi-character RP scenario
    // In multi-character RP, all assistant messages share the same msg.name
    // (the {{char}} card's display name), so scanning speaker names is useless.
    // Detect: count unique non-user speaker names across scene messages.
    const uniqueSpeakers = new Set();
    for (const msg of sceneMessages) {
        if (msg.name && !msg.is_user) {
            uniqueSpeakers.add(msg.name.toLowerCase().trim());
        }
    }
    const isMultiCharRP = uniqueSpeakers.size <= 1 && charIds.length > 1;
    dlog(`[RST] getSceneCharacters: uniqueSpeakers=${uniqueSpeakers.size}, sceneHasChars=${charIds.length}, isMultiCharRP=${isMultiCharRP}`);

    if (!isMultiCharRP) {
        // Step 2 (single-character RP): Scan scene message speakers for additional characters.
        // This catches NPCs the sidecar may have missed (pre-existing chats,
        // frequency-gated detection gaps, etc.)
        for (const msg of sceneMessages) {
            const speaker = msg.name || "";
            if (!speaker || msg.is_user || isExcluded(speaker)) continue;
            // Use alias-aware fuzzy matching so "Gojo" matches "Satoru Gojo"
            const match = findCharacterByFuzzyName(speaker) || allKnownChars.find((c) => c.name.toLowerCase().trim() === speaker.toLowerCase().trim());
            if (match) {
                foundIds.add(match.id);
            } else {
                unknownSpeakers.add(speaker);
            }
        }
    } else {
        dlog("[RST] Multi-character RP detected — trusting scene.charactersPresent, skipping speaker-name scan.");
    }

    // Step 3: Build character list from found IDs + auto-create unknowns
    const chars = [];
    for (const id of foundIds) {
        const profile = getCharacterProfile(id);
        if (profile) chars.push(profile);
    }

    // Auto-create characters for unknown non-user speakers (single-character RP only)
    if (unknownSpeakers.size > 0) {
        dlog("[RST] Auto-creating", unknownSpeakers.size, "character(s) from scene speakers:", [...unknownSpeakers]);
        for (const name of unknownSpeakers) {
            const char = createCharacter(name, { source: "auto_generated" });
            if (char) {
                _autoCreatedIds.add(char.id);
                chars.push(char);
            }
        }

        // Update scene's charactersPresent so subsequent calls find them
        try {
            const allIds = [...foundIds, ...chars.filter(c => c && c.id).map(c => c.id)];
            if (allIds.length > 0) {
                updateSceneCharacters(scene.id, allIds);
            }
        } catch (e) {
            console.warn("[RST] Could not update scene.charactersPresent:", e);
        }
    }

    // Step 4: Filter out any blacklisted/excluded characters from the final list
    const filteredChars = chars.filter(c => c && !isExcluded(c.name));
    const removedCount = chars.length - filteredChars.length;
    if (removedCount > 0) {
        dlog(`[RST] getSceneCharacters: removed ${removedCount} excluded character(s) from scene character list`);
    }

    dlog("[RST] getSceneCharacters: found", filteredChars.length, "characters (scene had", charIds.length, "registered)");
    return filteredChars;
}

/**
 * Merge LLM-provided stats over existing stats so unmentioned stats
 * retain their current value instead of defaulting to 0.
 * Only the specific stats the LLM included (defined !== undefined) are overridden.
 * @param {object} statsBefore - Current stat values (baseline)
 * @param {object} llmStats - Partial stats from LLM response (may have missing categories/stats)
 * @returns {object} Merged stats object
 */
function mergeWithExistingStats(statsBefore, llmStats) {
    const merged = cloneStats(statsBefore);
    for (const cat of STAT_CATEGORIES) {
        if (!llmStats[cat] || typeof llmStats[cat] !== "object") continue;
        for (const stat of STAT_NAMES) {
            // Only override if the LLM explicitly provided a value
            const val = llmStats[cat][stat];
            if (typeof val === "number" && !isNaN(val)) {
                merged[cat][stat] = val;
            }
            // null, undefined, NaN, or non-number → keep statsBefore value
        }
    }
    return merged;
}

/**
 * Clamp all stat values to [-100, 100].
 * @param {object} stats
 * @returns {object}
 */
function clampStats(stats) {
    const clamped = {};
    for (const cat of STAT_CATEGORIES) {
        clamped[cat] = {};
        for (const stat of STAT_NAMES) {
            const val = stats[cat]?.[stat] ?? 0;
            clamped[cat][stat] = Math.max(-100, Math.min(100, val));
        }
    }
    return clamped;
}

/**
 * Apply the configured stat change range to clamp statsAfter relative to statsBefore.
 * Ensures each stat stays within [range.min, range.max] of its current value.
 * This prevents LLM from making wild jumps beyond the configured per-scene limit.
 * @param {object} statsBefore - Current stat values
 * @param {object} statsAfter - Raw LLM-proposed stat values
 * @param {{min: number, max: number}} range - Allowed delta range from settings
 * @returns {object} Clamped statsAfter values
 */
function applyDeltaRange(statsBefore, statsAfter, range) {
    const result = {};
    for (const cat of STAT_CATEGORIES) {
        result[cat] = {};
        for (const stat of STAT_NAMES) {
            const before = statsBefore[cat]?.[stat] ?? 0;
            const after = statsAfter[cat]?.[stat] ?? 0;
            const minVal = before + range.min;
            const maxVal = before + range.max;
            result[cat][stat] = Math.max(minVal, Math.min(maxVal, after));
        }
    }
    return result;
}

/**
 * Create a blank commentary object.
 * @returns {object}
 */
function createBlankCommentary() {
    const commentary = {};
    for (const cat of STAT_CATEGORIES) {
        commentary[cat] = {};
        for (const stat of STAT_NAMES) {
            commentary[cat][stat] = "No change.";
        }
    }
    return commentary;
}

function hasEmptyCommentary(commentary) {
    if (!commentary || typeof commentary !== "object") return true;
    // Only return true if commentary is completely missing or empty object
    // We no longer require ALL 12 slots — partial commentary is fine
    let hasAnyContent = false;
    for (const cat of STAT_CATEGORIES) {
        if (!commentary[cat]) continue;
        for (const stat of STAT_NAMES) {
            if (commentary[cat][stat] && commentary[cat][stat].trim() !== "") {
                hasAnyContent = true;
                break;
            }
        }
        if (hasAnyContent) break;
    }
    return !hasAnyContent;
}

/**
 * Get the most recent commentary for a specific stat from a character's update log.
 * Used to preserve narrative continuity for unchanged stats across updates.
 * @param {object} char - Character profile (with updateLog)
 * @param {string} cat - Stat category
 * @param {string} stat - Stat name
 * @returns {string} The commentary text, or empty string if none found
 */
function getLatestCommentary(char, cat, stat) {
    if (char?.updateLog?.length > 0) {
        const latest = char.updateLog[0];
        const text = latest.commentary?.[cat]?.[stat];
        if (text && typeof text === "string" && text.trim() !== "") {
            return text.trim();
        }
    }
    return "";
}

/**
 * Fill in empty commentary slots for stats that actually changed.
 * Preserves existing LLM commentary for stats that already have it.
 * For unchanged stats with no LLM commentary, preserves the latest
 * commentary from the character's update log for narrative continuity.
 * @param {object} commentary - Partially filled commentary from LLM
 * @param {object} statsBefore
 * @param {object} statsAfter
 * @param {object} [char] - Character profile (for old commentary lookup)
 * @returns {object}
 */
function fillMissingCommentary(commentary, statsBefore, statsAfter, char) {
    const result = {};
    for (const cat of STAT_CATEGORIES) {
        result[cat] = {};
        for (const stat of STAT_NAMES) {
            const existing = commentary?.[cat]?.[stat];
            if (existing && existing.trim() !== "") {
                // Preserve LLM-provided commentary
                result[cat][stat] = existing;
            } else {
                const before = statsBefore[cat]?.[stat] ?? 0;
                const after = statsAfter[cat]?.[stat] ?? 0;
                const diff = after - before;
                if (diff > 0) {
                    result[cat][stat] = `Scene events positively influenced ${cat}.${stat}.`;
                } else if (diff < 0) {
                    result[cat][stat] = `Scene events negatively influenced ${cat}.${stat}.`;
                } else {
                    // Unchanged stat — preserve old commentary from update log
                    const oldCommentary = getLatestCommentary(char, cat, stat);
                    if (oldCommentary) {
                        result[cat][stat] = oldCommentary;
                    } else {
                        // No old commentary either — leave empty (no overwrite)
                        result[cat][stat] = "";
                    }
                }
            }
        }
    }
    return result;
}

/**
 * Generate fallback commentary from stat deltas when LLM provides NO commentary at all.
 * Only generates narrative for stats that actually changed.
 * For unchanged stats, preserves the latest commentary from the character's
 * update log for narrative continuity.
 * @param {object} statsBefore
 * @param {object} statsAfter
 * @param {object} [char] - Character profile (for old commentary lookup)
 * @returns {object}
 */
function generateFallbackCommentary(statsBefore, statsAfter, char) {
    const commentary = {};
    for (const cat of STAT_CATEGORIES) {
        commentary[cat] = {};
        for (const stat of STAT_NAMES) {
            const before = statsBefore[cat]?.[stat] ?? 0;
            const after = statsAfter[cat]?.[stat] ?? 0;
            const diff = after - before;
            if (diff > 0) {
                commentary[cat][stat] = `Scene events positively influenced ${cat}.${stat}.`;
            } else if (diff < 0) {
                commentary[cat][stat] = `Scene events negatively influenced ${cat}.${stat}.`;
            } else {
                // Unchanged stat — preserve old commentary from update log
                const oldCommentary = getLatestCommentary(char, cat, stat);
                if (oldCommentary) {
                    commentary[cat][stat] = oldCommentary;
                } else {
                    // No old commentary either — leave empty (no overwrite)
                    commentary[cat][stat] = "";
                }
            }
        }
    }
    return commentary;
}

function createNoChangeEntry(char) {
    const stats = cloneStats(char.stats);
    // Pass char for old commentary lookup; unchanged stats preserve their update-log commentary
    const preservedCommentary = generateFallbackCommentary(stats, stats, char);
    return {
        characterId: char.id,
        characterName: char.name,
        statsBefore: stats,
        statsAfter: stats,
        commentary: preservedCommentary,
        dynamicTitleBefore: char.dynamicTitle || "",
        dynamicTitleAfter: char.dynamicTitle || "",
        narrativeSummary: char.narrativeSummary || "",
        source: "llm",
        changeCount: 0,
    };
}

/**
 * Count how many stats actually changed.
 * @param {object} before
 * @param {object} after
 * @returns {number}
 */
function countChanges(before, after) {
    let count = 0;
    for (const cat of STAT_CATEGORIES) {
        for (const stat of STAT_NAMES) {
            if (before[cat][stat] !== after[cat][stat]) count++;
        }
    }
    return count;
}

// ─── Initial Stat Generation (for new characters) ─────────

/**
 * Check if a character is brand new (all stats at 0%).
 * @param {object} char - Character profile
 * @returns {boolean}
 */
function isNewCharacter(char) {
    if (!char || !char.stats) return true;
    for (const cat of STAT_CATEGORIES) {
        for (const stat of STAT_NAMES) {
            if (char.stats[cat]?.[stat] !== 0) return false;
        }
    }
    return true;
}

/**
 * Generate initial stats for brand-new characters using a flexible prompt
 * that allows context-appropriate starting values (not constrained by statChangeRange).
 * @param {Array} messages - Scene messages
 * @param {Array} characters - New character profiles (all stats at 0%)
 * @param {string} profileName - LLM profile to use
 * @param {object} settings - Extension settings
 * @returns {Promise<{sceneSummary: string, characterUpdates: Array}>}
 */
async function generateInitialStatsForScene(messages, characters, profileName, settings) {
    const systemPrompt = buildInitialStatSystemPrompt(settings);
    const requestPrompt = buildInitialStatRequestPrompt(messages, characters, settings);

    const result = await makeRequest(profileName, systemPrompt, requestPrompt, 4000, 0.3);
    if (!result) {
        return { sceneSummary: "", characterUpdates: [] };
    }

    return parseInitialStatResponse(result, characters);
}

/**
 * Build system prompt for initial stat generation (no change range constraints).
 * @param {object} settings
 * @returns {string}
 */
function buildInitialStatSystemPrompt(settings) {
    return [
        'You are a relationship stat generator for new characters.',
        'Output ONLY a JSON object.',
        '',
        '',
        'Schema:',
        '  {',
        '    "sceneTitle": "A short evocative title for this scene",',
        '    "sceneSummary": "Concise summary of the scene...",',
        '    "characters": {',
        '      "[CHARACTER_NAME]": {',
        '        "stats": {',
        '          "platonic": {"trust":-100-100,"openness":-100-100,"support":-100-100,"affection":-100-100},',
        '          "romantic": {"trust":-100-100,"openness":-100-100,"support":-100-100,"affection":-100-100},',
        '          "sexual": {"trust":-100-100,"openness":-100-100,"support":-100-100,"affection":-100-100}',
        '        },',
        '        "commentary": {',
        '          "platonic": {"trust":"reason","openness":"reason","support":"reason","affection":"reason"},',
        '          "romantic": {"trust":"reason","openness":"reason","support":"reason","affection":"reason"},',
        '          "sexual": {"trust":"reason","openness":"reason","support":"reason","affection":"reason"}',
        '        },',
        '        "dynamicTitle": "...",',
        '        "narrativeSummary": "..."',
        '      }',
        '    }',
        '  }',
        '',
        'Rules:',
        '- Stats represent character\'s feelings toward {{user}}, not reverse.',
        '- Range: -100 to 100. 0 = neutral.',
        '- Commentary: explain each stat from scene events.',
        '- Dynamic title: character\'s relationship role/attitude toward {{user}}.',
    ].join('\n');
}

/**
 * Build request prompt for initial stat generation.
 * @param {Array} messages - Scene messages
 * @param {Array} characters - Character profiles
 * @param {object} settings
 * @returns {string}
 */
function buildInitialStatRequestPrompt(messages, characters, settings) {
    const parts = [];

    parts.push(`SCENE SUMMARY INSTRUCTIONS:\n${settings.sceneSummaryPrompt || "Write a concise scene summary for internal reference."}`);
    parts.push("");

    // Character list
    parts.push("CHARACTERS IN THIS SCENE (stats represent character \u2192 {{user}} perspective):");
    for (const char of characters) {
        const aliases = getCharacterNameVariants(char).filter(a => a !== char.name.toLowerCase().trim());
        const aliasStr = aliases.length > 0 ? ` (also known as: ${aliases.join(", ")})` : "";
        parts.push("- " + char.name + aliasStr);
    }
    parts.push("");

    // Scene messages
    const userName = getContext().name1 || "User";
    parts.push("SCENE MESSAGES (\"" + userName + "\" is the user/player, all other named speakers are characters):");
    messages.forEach((m, i) => {
        const speaker = m.name || "Unknown";
        const text = m.mes || "";
        const isUser = m.is_user ? " [USER]" : "";
        parts.push("[" + i + "]" + isUser + " " + speaker + ": " + text);
    });

    // Character discovery instruction — be INCLUSIVE by default
    parts.push('');
    parts.push('CRITICAL — Scan for ALL additional characters:');
    parts.push('- You MUST identify EVERY named individual who appears, speaks, interacts, or is described as doing something in the scene messages.');
    parts.push('- INCLUDE characters who: speak dialogue, are addressed by name, perform actions described by another speaker, interact with someone in the scene, or are described as being physically present or doing an activity.');
    parts.push('- Example of INCLUDE: a character says "I talked with [Name]" or "[Name] handed me the package" — [Name] is described as interacting and should be included.');
    parts.push('- Example of EXCLUDE: "I heard about [Name]\'s reputation" — [Name] is merely discussed with no described interaction.');
    parts.push('- When in doubt, INCLUDE the character.');
    parts.push('Include them in your characters object with full stat estimates based on their scene behavior.');
    parts.push('');

    // Force JSON-only output
    parts.push('Return JSON only.');

    return parts.join("\n");
}

/**
 * Parse the initial stat LLM response.
 * @param {string} response - Raw LLM output
 * @param {Array} characters - Character profiles
 * @returns {{sceneSummary: string, characterUpdates: Array}}
 */
function parseInitialStatResponse(response, characters) {
    const parsed = extractJsonFromResponse(response);
    if (!parsed) {
        // Try analysis-text fallback before giving up on character data
        const fallbackResult = parseStatUpdateAnalysisText(response, characters);
        if (fallbackResult) {
            dlog("[RST] Parsed initial stat response using analysis-text fallback");
            return fallbackResult;
        }
        const partial = extractPartialData(response);
        console.warn(`[RST] Could not fully parse initial stat response. Using partial data.`, partial);
        return {
            sceneSummary: partial.sceneSummary,
            sceneTitle: partial.sceneTitle,
            characterUpdates: [],
        };
    }

    const sceneSummary = parsed.sceneSummary || "";
    const sceneTitle = parsed.sceneTitle || "";
    const characterUpdates = [];

    for (const char of characters) {
        const charData = parsed.characters?.[char.name];
        if (!charData || !charData.stats) {
            // Character not in response — create a no-change entry at zero
            characterUpdates.push(createNoChangeEntry(char));
            continue;
        }

        const statsAfter = {};
        for (const cat of STAT_CATEGORIES) {
            statsAfter[cat] = {};
            for (const stat of STAT_NAMES) {
                const val = charData.stats[cat]?.[stat];
                statsAfter[cat][stat] = typeof val === "number" ? Math.max(-100, Math.min(100, val)) : 0;
            }
        }

        const commentary = charData.commentary || null;
        if (!commentary || hasEmptyCommentary(commentary)) {
            // Since there are no "before" stats, use a generic narrative-only fallback
            const fallback = {};
            for (const cat of STAT_CATEGORIES) {
                fallback[cat] = {};
                for (const stat of STAT_NAMES) {
                    const val = statsAfter[cat][stat];
                    if (val > 0) {
                        fallback[cat][stat] = "First impressions suggest positive feelings.";
                    } else if (val < 0) {
                        fallback[cat][stat] = "First impressions suggest negative feelings.";
                    } else {
                        fallback[cat][stat] = "No strong initial impression formed.";
                    }
                }
            }
            characterUpdates.push({
                characterId: char.id,
                characterName: char.name,
                statsBefore: null, // No previous stats
                statsAfter,
                commentary: fallback,
                dynamicTitleBefore: "",
                dynamicTitleAfter: charData.dynamicTitle || "",
                milestoneReached: false,
                milestoneDetail: "",
                narrativeSummary: charData.narrativeSummary || "",
                source: "llm_initial",
                changeCount: 12, // All 12 stats are "new"
            });
        } else {
            characterUpdates.push({
                characterId: char.id,
                characterName: char.name,
                statsBefore: null,
                statsAfter,
                commentary,
                dynamicTitleBefore: "",
                dynamicTitleAfter: charData.dynamicTitle || "",
                milestoneReached: false,
                milestoneDetail: "",
                narrativeSummary: charData.narrativeSummary || "",
                source: "llm_initial",
                changeCount: 12,
            });
        }
    }

    // Handle LLM-discovered characters (in parsed.characters but not in input list)
    if (parsed && parsed.characters) {
        const inputNames = new Set(characters.map(c => c.name));
        const allKnownChars = getAllCharacters();
        for (const [llmName, llmData] of Object.entries(parsed.characters)) {
            if (!inputNames.has(llmName) && llmData && llmData.stats) {
                const lowerLlmName = llmName.toLowerCase().trim();
                // Check if this LLM name matches an existing character (by alias, exact name, or fuzzy word match)
                const matchedExisting = allKnownChars.find(c => {
                    if (c.name.toLowerCase().trim() === lowerLlmName) return true;
                    if (c.nameAliases && Array.isArray(c.nameAliases)) {
                        if (c.nameAliases.some(a => a.toLowerCase().trim() === lowerLlmName)) return true;
                    }
                    const cWords = c.name.toLowerCase().trim().split(/\s+/).filter(Boolean).sort().join(" ");
                    const llmWords = lowerLlmName.split(/\s+/).filter(Boolean).sort().join(" ");
                    return cWords === llmWords;
                });
                if (matchedExisting) {
                    // Name matches existing character — create update entry instead of duplicate
                    dlog(`[RST] LLM name "${llmName}" matches existing character "${matchedExisting.name}" — creating initial stat update entry`);
                    const statsAfter = {};
                    for (const cat of STAT_CATEGORIES) {
                        statsAfter[cat] = {};
                        for (const stat of STAT_NAMES) {
                            const val = llmData.stats[cat]?.[stat];
                            statsAfter[cat][stat] = typeof val === "number" ? Math.max(-100, Math.min(100, val)) : 0;
                        }
                    }
                    const statsBefore = cloneStats(matchedExisting.stats);
                    const settings = getSettings();
                    const range = settings.statChangeRange || { min: -5, max: 5 };
                    // Merge LLM stats over existing stats so unmentioned ones don't default to 0
                    const mergedStats = mergeWithExistingStats(statsBefore, statsAfter);
                    const clampedAfter = applyDeltaRange(statsBefore, mergedStats, range);
                    let commentary = llmData.commentary || null;
                    if (!commentary || hasEmptyCommentary(commentary)) {
                        commentary = generateFallbackCommentary(statsBefore, clampedAfter, matchedExisting);
                    } else {
                        commentary = fillMissingCommentary(commentary, statsBefore, clampedAfter, matchedExisting);
                    }
                    const changeCount = countChanges(statsBefore, clampedAfter);
                    characterUpdates.push({
                        characterId: matchedExisting.id,
                        characterName: matchedExisting.name,
                        statsBefore,
                        statsAfter: clampedAfter,
                        commentary,
                        dynamicTitleBefore: matchedExisting.dynamicTitle || "",
                        dynamicTitleAfter: llmData.dynamicTitle || matchedExisting.dynamicTitle || "",
                        milestoneReached: false,
                        milestoneDetail: "",
                        narrativeSummary: llmData.narrativeSummary || matchedExisting.narrativeSummary || "",
                        source: "llm_initial",
                        changeCount,
                    });
                } else {
                    // Truly new character — create new profile
                    dlog("[RST] LLM discovered additional character (initial stat):", llmName);
                    const newChar = createCharacter(llmName, { source: "auto_generated" });
                    if (newChar) {
                        _autoCreatedIds.add(newChar.id);
                        const statsAfter = {};
                        for (const cat of STAT_CATEGORIES) {
                            statsAfter[cat] = {};
                            for (const stat of STAT_NAMES) {
                                const val = llmData.stats[cat]?.[stat];
                                statsAfter[cat][stat] = typeof val === "number" ? Math.max(-100, Math.min(100, val)) : 0;
                            }
                        }
                        const commentary = llmData.commentary || null;
                        if (!commentary || hasEmptyCommentary(commentary)) {
                            const fallback = {};
                            for (const cat of STAT_CATEGORIES) {
                                fallback[cat] = {};
                                for (const stat of STAT_NAMES) {
                                    const val = statsAfter[cat][stat];
                                    if (val > 0) {
                                        fallback[cat][stat] = "First impressions suggest positive feelings.";
                                    } else if (val < 0) {
                                        fallback[cat][stat] = "First impressions suggest negative feelings.";
                                    } else {
                                        fallback[cat][stat] = "No strong initial impression formed.";
                                    }
                                }
                            }
                            characterUpdates.push({
                                characterId: newChar.id,
                                characterName: newChar.name,
                                statsBefore: null,
                                statsAfter,
                                commentary: fallback,
                                dynamicTitleBefore: "",
                                dynamicTitleAfter: llmData.dynamicTitle || "",
                                milestoneReached: false,
                                milestoneDetail: "",
                                narrativeSummary: llmData.narrativeSummary || "",
                                source: "llm_discovered_initial",
                                changeCount: 12,
                            });
                        } else {
                            characterUpdates.push({
                                characterId: newChar.id,
                                characterName: newChar.name,
                                statsBefore: null,
                                statsAfter,
                                commentary,
                                dynamicTitleBefore: "",
                                dynamicTitleAfter: llmData.dynamicTitle || "",
                                milestoneReached: false,
                                milestoneDetail: "",
                                narrativeSummary: llmData.narrativeSummary || "",
                                source: "llm_discovered_initial",
                                changeCount: 12,
                            });
                        }
                    }
                }
            }
        }
    }

    return { sceneSummary, sceneTitle, characterUpdates };
}
