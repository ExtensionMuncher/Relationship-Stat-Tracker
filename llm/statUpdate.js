/**
 * statUpdate.js — Main LLM: scene review + stat generation
 * Reviews closed scenes, generates stat changes, commentary, dynamic titles,
 * narrative summaries, AND scene summaries (single LLM call)
 */

import { chat, getContext } from "../../../../../script.js";
import { makeRequest } from "./connections.js";
import { getSettings } from "../data/storage.js";
import { getCharacterProfile, cloneStats, STAT_CATEGORIES, STAT_NAMES } from "../data/characters.js";
import { getSceneById, getAllSceneSummaries } from "../data/scenes.js";

// ─── Main Generation Function ─────────────────────────────

/**
 * Generate stat updates for all characters present in a closed scene.
 * @param {string} sceneId - The scene to review
 * @param {string} [guidance] - Optional user guidance for regeneration
 * @returns {Promise<object>} The full update result
 */
export async function generateStatUpdate(sceneId, guidance = "") {
    const settings = getSettings();
    const scene = getSceneById(sceneId);
    if (!scene) throw new Error(`Scene ${sceneId} not found`);

    const profileName = settings.connections.statUpdateLLM;
    const sceneMessages = getSceneMessages(scene);
    const characters = getSceneCharacters(scene);
    const pastSummaries = getAllSceneSummaries();

    if (characters.length === 0) {
        throw new Error("No characters found in scene");
    }

    const systemPrompt = buildStatUpdateSystemPrompt(settings);
    const requestPrompt = buildStatUpdateRequestPrompt(
        sceneMessages,
        characters,
        pastSummaries,
        settings,
        guidance
    );

    try {
        toastr?.info?.("Generating stat updates...");

        const result = await makeRequest(
            profileName,
            systemPrompt + "\n\n" + requestPrompt,
            2000,
        );

        if (!result) throw new Error("No response from LLM");

        const parsed = parseStatUpdateResponse(result, characters);
        return {
            sceneId,
            sceneSummary: parsed.sceneSummary,
            summaryGuidance: guidance,
            characterUpdates: parsed.characterUpdates,
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

    return `You are a relationship analysis assistant. You review roleplay scenes and assess how character relationships have evolved or devolved.

Your task:
1. Write a concise SCENE SUMMARY for internal reference (clinical, factual)
2. For each character present, analyze how the scene affected their relationship stats
3. Determine if any relationship milestones were reached, triggering a dynamic title change

# PERSPECTIVE RULE (CRITICAL — DO NOT VIOLATE):
- All stats represent how the DETECTED CHARACTER feels toward {{user}} — NOT the other way around!
- Example: "Alice's platonic.trust = 30%" means Alice trusts {{user}} at 30%, NOT that {{user}} trusts Alice at 30%
- Each character's stats are ALWAYS measured from that character's perspective toward {{user}}
- Commentary must explain why the CHARACTER's feelings toward {{user}} changed based on scene events
- Dynamic titles describe the CHARACTER's relationship role/attitude toward {{user}}
- Never generate stats from {{user}}'s perspective toward a character — always character → user direction

# RELATIONSHIP ATTRACTION TYPES:
- Platonic: A deep, non-romantic desire for connection, characterized by emotional closeness, shared values, and a strong friendship bond. It involves trust, openness, and a sense of mutual support.
- Romantic: A longing for emotional intimacy and affectionate connection, accompanied by a desire for commitment or partnership. This attraction can include gestures of love, deep emotional exchanges, and non-sexual physical affection like hugging, cuddling, or kissing.
- Sexual: A physical and intimate desire driven by attraction to body, features, or presence. It may include both sexual interest and the longing for physical closeness.

# RELATIONSHIP ELEMENTS:
- Trust: Foundation of any relationship, built on honesty, reliability, and consistency.
- Openness: Willingness to share thoughts, feelings, desires, and vulnerabilities in an honest and transparent way.
- Support: Being there emotionally, mentally, and sometimes physically.
- Affection: Expressing love and care through words, actions, or physical touch.

# STAT RULES:
- Each stat is a percentage from -100% to 100%
- Stat changes per scene MUST be between ${range.min}% and ${range.max}% — enforce slow-burn progression
- A stat of 0% means neutral/undeveloped
- Once a stat reaches 100% or -100%, stop updating it (or regress based on scene events)
- Multiple attraction/element types can update at once, and may not remain static
- Focus on slow-burn: relationships should evolve gradually, not dramatically

# MILESTONE SYSTEM (Dynamic Titles):
- A milestone is reached when ALL four elements (trust, openness, support, affection) in a given attraction type cross a significant threshold
- Thresholds: 25% (emerging), 50% (developing), 75% (strong), 100% (maxed)
- When a milestone is reached, the dynamic title should reflect the new relationship state
- Dynamic titles are short phrases like "The Tentative Ally", "The Unraveling", "The Reluctant Partner"
- Format the dynamic title change as: "[OLD TITLE] → [NEW TITLE]" if a milestone was reached
- If no milestone was reached, keep the existing dynamic title

# COMMENTARY RULES:
- Provide commentary for EVERY stat explaining why it changed (or didn't)
- Commentary should be specific to the scene events, not generic
- If a stat didn't change, explain what prevented the shift

RESPONSE FORMAT — return ONLY valid JSON:
{
  "sceneSummary": "Concise summary of what happened in this scene...",
  "characters": {
    "[CHARACTER_NAME]": {
      "stats": {
        "platonic": { "trust": X, "openness": X, "support": X, "affection": X },
        "romantic": { "trust": X, "openness": X, "support": X, "affection": X },
        "sexual": { "trust": X, "openness": X, "support": X, "affection": X }
      },
      "commentary": {
        "platonic": { "trust": "reason", "openness": "reason", "support": "reason", "affection": "reason" },
        "romantic": { "trust": "reason", "openness": "reason", "support": "reason", "affection": "reason" },
        "sexual": { "trust": "reason", "openness": "reason", "support": "reason", "affection": "reason" }
      },
      "dynamicTitle": "The [Adjective] [Noun]",
      "milestoneReached": false,
      "milestoneDetail": "e.g. 'Romantic trust crossed 50%' or empty string",
      "narrativeSummary": "2-3 sentence relationship trajectory assessment"
    }
  }
}

The stats values should be the NEW total values (not deltas). For example, if trust was 30% and went up by 3, write 33.`;
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
        parts.push(`\n${char.name}:`);
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
    let parsed;
    try {
        // Try direct parse
        parsed = JSON.parse(response.trim());
    } catch {
        // Try to extract JSON from response
        const match = response.match(/\{[\s\S]*\}/);
        if (match) {
            parsed = JSON.parse(match[0]);
        } else {
            throw new Error("Failed to parse stat update response as JSON");
        }
    }

    const sceneSummary = parsed.sceneSummary || "";
    const characterUpdates = [];

    for (const char of characters) {
        const charData = parsed.characters?.[char.name];
        if (!charData) {
            // Character not found in LLM response — create a no-change entry
            characterUpdates.push(createNoChangeEntry(char));
            continue;
        }

        const statsBefore = cloneStats(char.stats);
        const statsAfter = clampStats(charData.stats || char.stats);
        const commentary = charData.commentary || createBlankCommentary();

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

    return { sceneSummary, characterUpdates };
}

// ─── Helpers ──────────────────────────────────────────────

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
    const charIds = scene.charactersPresent || [];
    const chars = [];
    for (const id of charIds) {
        const profile = getCharacterProfile(id);
        if (profile) chars.push(profile);
    }
    return chars;
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

/**
 * Create a no-change entry for a character not found in LLM response.
 * @param {object} char - Character profile
 * @returns {object}
 */
function createNoChangeEntry(char) {
    const stats = cloneStats(char.stats);
    return {
        characterId: char.id,
        characterName: char.name,
        statsBefore: stats,
        statsAfter: stats,
        commentary: createBlankCommentary(),
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
