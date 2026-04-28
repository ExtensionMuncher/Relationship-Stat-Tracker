/**
 * batchScan.js — Full chat history batch scan
 * Scans existing chat history, auto-detects scene boundaries, identifies characters,
 * creates profiles for unknown names, and generates initial scene summaries + stat blocks.
 *
 * Non-compounding: Skips message ranges already covered by existing scenes.
 */

import { chat } from "../../../../../script.js";
import { makeRequest } from "./connections.js";
import { getSettings } from "../data/storage.js";
import { getScenes, saveScenes } from "../data/storage.js";
import { findCharacterByName, createCharacter, updateCharacterStats, getCharacterProfile, STAT_CATEGORIES, STAT_NAMES } from "../data/characters.js";
import { initSceneCounter, updateSceneSummary } from "../data/scenes.js";

// ─── Main Entry Point ─────────────────────────────────────

/**
 * Run a full batch scan of the current chat.
 * Orchestrates all 4 phases:
 *   1. Scene detection (autoGenLLM)
 *   2. Character profile creation for unknown names
 *   3. Scene object creation
 *   4. Initial summary + stat generation (statUpdateLLM)
 *
 * Non-compounding: Skips message ranges already covered by existing scenes.
 *
 * @returns {Promise<{scenesCreated: number, profilesCreated: string[]}>}
 */
export async function runBatchScan() {
    const settings = getSettings();
    const autoGenProfile = settings.connections.autoGenLLM;
    const statUpdateProfile = settings.connections.statUpdateLLM;

    if (!autoGenProfile) {
        toastr?.warning?.("Batch scan requires an Auto-Gen LLM profile. Configure one in Settings > Connection profiles.");
        return { scenesCreated: 0, profilesCreated: [] };
    }

    if (!statUpdateProfile) {
        toastr?.warning?.("Batch scan requires a Stat Update LLM profile. Configure one in Settings > Connection profiles.");
        return { scenesCreated: 0, profilesCreated: [] };
    }

    if (!chat || chat.length < 3) {
        toastr?.warning?.("Chat history is too short for batch scan (need at least 3 messages).");
        return { scenesCreated: 0, profilesCreated: [] };
    }

    const allMessages = chat;
    const existingScenes = getScenes();

    // Non-compounding: determine unprocessed message ranges
    const ranges = getUnprocessedRanges(existingScenes, allMessages.length);
    if (ranges.length === 0) {
        toastr?.info?.("All messages already covered by existing scenes. Nothing to scan.");
        return { scenesCreated: 0, profilesCreated: [] };
    }

    toastr?.info?.("Batch scan: Analyzing chat for scene boundaries...");

    // Phase 1: Detect scenes via LLM
    const detectedScenes = await detectScenes(allMessages, ranges, autoGenProfile, settings);
    if (!detectedScenes || detectedScenes.length === 0) {
        toastr?.warning?.("Batch scan: No scenes detected in the chat history.");
        return { scenesCreated: 0, profilesCreated: [] };
    }

    // Phase 2: Create profiles for unknown characters
    const profilesCreated = [];
    const allCharNames = new Set();
    for (const scene of detectedScenes) {
        for (const name of scene.characters) {
            allCharNames.add(name);
        }
    }

    for (const name of allCharNames) {
        const existing = findCharacterByName(name);
        if (!existing) {
            createCharacter(name, { source: "auto_generated" });
            profilesCreated.push(name);
        }
    }

    // Phase 3: Create scene objects
    const createdScenes = [];
    initSceneCounter(); // Ensure counter is up-to-date

    for (const detected of detectedScenes) {
        const charIds = detected.characters
            .map((name) => {
                const profile = findCharacterByName(name);
                return profile ? profile.id : null;
            })
            .filter(Boolean);

        // Create scene as closed (historical)
        const scenes = getScenes();
        const counterMatch = scenes
            .map((s) => s.id.match(/scene_(\d+)/))
            .filter(Boolean)
            .map((m) => parseInt(m[1], 10));
        const nextNum = counterMatch.length > 0 ? Math.max(...counterMatch) + 1 : scenes.length + 1;

        const newScene = {
            id: `scene_${nextNum}`,
            status: "closed",
            messageStart: detected.messageStart,
            messageEnd: detected.messageEnd,
            charactersPresent: charIds,
            llmSummary: "",
            timestamp: Date.now(),
        };

        scenes.push(newScene);
        saveScenes(scenes);
        createdScenes.push(newScene);
    }

    // Phase 4: Generate summaries + initial stat blocks
    let scenesProcessed = 0;
    for (const scene of createdScenes) {
        try {
            toastr?.info?.(`Batch scan: Processing scene ${scene.id} (${scene.messageStart}-${scene.messageEnd})...`);

            const sceneMessages = allMessages.slice(scene.messageStart, scene.messageEnd + 1);
            const characters = scene.charactersPresent
                .map((id) => getCharacterProfile(id))
                .filter(Boolean);

            if (sceneMessages.length === 0 || characters.length === 0) {
                continue;
            }

            const result = await generateInitialStats(sceneMessages, characters, statUpdateProfile, settings);

            // Save scene summary
            if (result.sceneSummary) {
                updateSceneSummary(scene.id, result.sceneSummary);
            }

            // Apply initial stats to character profiles
            for (const charUpdate of result.characterUpdates) {
                const profile = getCharacterProfile(charUpdate.characterId);
                if (profile) {
                    updateCharacterStats(charUpdate.characterId, charUpdate.statsAfter);
                }
            }

            scenesProcessed++;
        } catch (err) {
            console.error(`[RST] Batch scan: Failed to process scene ${scene.id}:`, err);
        }
    }

    toastr?.success?.(`Batch scan complete: ${createdScenes.length} scenes created, ${profilesCreated.length} profiles generated.`);

    return {
        scenesCreated: createdScenes.length,
        profilesCreated,
    };
}

// ─── Phase 1: Scene Detection ─────────────────────────────

/**
 * Detect scene boundaries and character names via LLM.
 * Processes messages in configurable chunks to avoid token limits.
 * @param {Array} allMessages - Full chat array
 * @param {Array<{start: number, end: number}>} ranges - Unprocessed message ranges
 * @param {string} profileName - autoGenLLM profile name
 * @param {object} settings - Full RST settings object
 * @returns {Promise<Array<{messageStart: number, messageEnd: number, characters: string[]}>>}
 */
async function detectScenes(allMessages, ranges, profileName, settings) {
    const systemPrompt = buildSceneDetectionSystemPrompt();
    const maxTokens = settings.batchScan?.sceneDetectionMaxTokens ?? 4000;
    const chunkSize = settings.batchScan?.chunkSize ?? 100;
    const allScenes = [];

    for (const range of ranges) {
        const messageCount = range.end - range.start + 1;
        if (messageCount <= chunkSize) {
            // Single chunk — process as-is
            const requestPrompt = buildSceneDetectionRequest(allMessages, [range]);
            const result = await makeRequest(profileName, systemPrompt, requestPrompt, maxTokens);
            if (result) {
                const parsed = parseSceneDetectionResponse(result, [range]);
                allScenes.push(...parsed);
            }
        } else {
            // Split into chunkSize-sized pieces
            for (let cs = range.start; cs <= range.end; cs += chunkSize) {
                const ce = Math.min(cs + chunkSize - 1, range.end);
                const chunkRange = { start: cs, end: ce };
                const requestPrompt = buildSceneDetectionRequest(allMessages, [chunkRange]);
                const result = await makeRequest(profileName, systemPrompt, requestPrompt, maxTokens);
                if (result) {
                    const parsed = parseSceneDetectionResponse(result, [chunkRange]);
                    allScenes.push(...parsed);
                }
            }
        }
    }

    return allScenes;
}

/**
 * Build the system prompt for scene detection.
 * @returns {string}
 */
function buildSceneDetectionSystemPrompt() {
    return `You are a scene analysis assistant. Your job is to analyze chat conversations and identify logical scene boundaries and character appearances.

# SCENE DEFINITION:
A "scene" is a narrative unit with a consistent setting, time period, and group of interacting characters. Scene boundaries occur when:
- The topic or activity changes significantly
- Characters enter or leave
- There's a notable time skip or location change

# RULES:
- Each scene MUST have at least 2 messages
- Scenes must not overlap
- Scene boundaries should be clean message breaks (whole messages)
- List character names exactly as they appear in the message sender labels
- Exclude "{{user}}" or "User" from the character list — only list non-user characters

# RESPONSE FORMAT — return ONLY valid JSON:
{
  "scenes": [
    {
      "messageStart": <int>,
      "messageEnd": <int>,
      "characters": ["Character1", "Character2"]
    }
  ]
}`;
}

/**
 * Build the request prompt with message ranges for scene detection.
 * @param {Array} allMessages - Full chat
 * @param {Array<{start: number, end: number}>} ranges - Ranges to analyze
 * @returns {string}
 */
function buildSceneDetectionRequest(allMessages, ranges) {
    const parts = [];

    parts.push("Analyze the following chat messages and identify scene boundaries within the specified message ranges.");
    parts.push("");

    for (const range of ranges) {
        parts.push(`--- MESSAGE RANGE ${range.start} to ${range.end} ---`);
        for (let i = range.start; i <= range.end && i < allMessages.length; i++) {
            const m = allMessages[i];
            const speaker = m.name || "Unknown";
            const text = (m.mes || "");
            parts.push(`[${i}] ${speaker}: ${text}`);
        }
        parts.push("");
    }

    return parts.join("\n");
}

/**
 * Parse the LLM scene detection response.
 * @param {string} response
 * @param {Array<{start: number, end: number}>} ranges - Valid message ranges
 * @returns {Array<{messageStart: number, messageEnd: number, characters: string[]}>}
 */
function parseSceneDetectionResponse(response, ranges) {
    let parsed;
    try {
        parsed = JSON.parse(response.trim());
    } catch {
        const preview = (response || "").substring(0, 200);
        console.debug("[RST] Batch scan: Scene detection raw response preview:", preview);
        const match = response.match(/\{[\s\S]*\}/);
        if (match) {
            try {
                parsed = JSON.parse(match[0]);
            } catch {
                console.error("[RST] Batch scan: Failed to parse scene detection response as JSON. finish_reason may be 'length' — try increasing max tokens.");
                return [];
            }
        } else {
            console.error("[RST] Batch scan: No JSON found in scene detection response. Response may be empty due to token limit.");
            return [];
        }
    }

    if (!parsed.scenes || !Array.isArray(parsed.scenes)) {
        console.error("[RST] Batch scan: Invalid scene detection response format");
        return [];
    }

    // Validate and constrain scene boundaries to the requested ranges
    const validScenes = [];
    for (const scene of parsed.scenes) {
        const start = parseInt(scene.messageStart, 10);
        const end = parseInt(scene.messageEnd, 10);

        if (isNaN(start) || isNaN(end) || start < 0 || end < start) continue;

        // Ensure scene falls within at least one valid range
        const inRange = ranges.some((r) => start >= r.start && end <= r.end);
        if (!inRange) continue;

        validScenes.push({
            messageStart: start,
            messageEnd: end,
            characters: Array.isArray(scene.characters) ? scene.characters : [],
        });
    }

    // Sort by messageStart and remove overlaps (keep first occurrence)
    validScenes.sort((a, b) => a.messageStart - b.messageStart);
    const nonOverlapping = [];
    let lastEnd = -1;
    for (const scene of validScenes) {
        if (scene.messageStart > lastEnd) {
            nonOverlapping.push(scene);
            lastEnd = scene.messageEnd;
        }
    }

    return nonOverlapping;
}

// ─── Non-Compounding Check ────────────────────────────────

/**
 * Determine which message ranges are not yet covered by existing scenes.
 * @param {Array} existingScenes - Current scene entries
 * @param {number} totalMessages - Total number of chat messages
 * @returns {Array<{start: number, end: number}>} Unprocessed ranges
 */
function getUnprocessedRanges(existingScenes, totalMessages) {
    if (existingScenes.length === 0) {
        return [{ start: 0, end: totalMessages - 1 }];
    }

    // Collect all covered message indices
    const covered = new Set();
    for (const scene of existingScenes) {
        if (scene.messageStart !== null && scene.messageEnd !== null) {
            for (let i = scene.messageStart; i <= scene.messageEnd; i++) {
                covered.add(i);
            }
        }
    }

    // Find contiguous unprocessed ranges
    const ranges = [];
    let rangeStart = null;

    for (let i = 0; i < totalMessages; i++) {
        if (!covered.has(i)) {
            if (rangeStart === null) rangeStart = i;
        } else {
            if (rangeStart !== null) {
                // Only add ranges with at least 3 messages
                if (i - rangeStart >= 3) {
                    ranges.push({ start: rangeStart, end: i - 1 });
                }
                rangeStart = null;
            }
        }
    }

    // Handle trailing range
    if (rangeStart !== null && totalMessages - rangeStart >= 3) {
        ranges.push({ start: rangeStart, end: totalMessages - 1 });
    }

    return ranges;
}

// ─── Phase 4: Initial Stat Generation ─────────────────────

/**
 * Generate initial stat values and scene summary for a batch-detected scene.
 * Uses a custom prompt designed for initial stat generation (no "change range" constraints).
 * @param {Array} messages - Scene messages
 * @param {Array} characters - Character profiles (with 0-initialized stats)
 * @param {string} profileName - statUpdateLLM profile
 * @param {object} settings
 * @returns {Promise<{sceneSummary: string, characterUpdates: Array}>}
 */
async function generateInitialStats(messages, characters, profileName, settings) {
    const systemPrompt = buildInitialStatSystemPrompt(settings);
    const requestPrompt = buildInitialStatRequestPrompt(messages, characters, settings);

    const maxTokens = settings.batchScan?.initialStatMaxTokens ?? 3000;
    const result = await makeRequest(profileName, systemPrompt, requestPrompt, maxTokens);
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
    return `You are a relationship analysis assistant. Your job is to assess initial character relationship states based on their first interactions in a scene.

Generate:
1. A concise SCENE SUMMARY (factual, clinical — short paragraph)
2. For each character, an INITIAL relationship stat assessment based on their behavior in the scene

# PERSPECTIVE RULE (CRITICAL — DO NOT VIOLATE):
- All stats represent how the DETECTED CHARACTER feels toward {{user}} — NOT the other way around!
- Example: "Alice's platonic.trust = 30%" means Alice trusts {{user}} at 30%, NOT that {{user}} trusts Alice at 30%
- Stats are ALWAYS measured from that character's perspective toward {{user}}
- Commentary should explain why the CHARACTER's feelings toward {{user}} manifested that way

# RELATIONSHIP ATTRACTION TYPES:
- Platonic: A deep, non-romantic desire for connection, characterized by emotional closeness, shared values, and a strong friendship bond.
- Romantic: A longing for emotional intimacy and affectionate connection, accompanied by a desire for commitment or partnership.
- Sexual: A physical and intimate desire driven by attraction to body, features, or presence.

# RELATIONSHIP ELEMENTS:
- Trust: Foundation of any relationship, built on honesty, reliability, and consistency.
- Openness: Willingness to share thoughts, feelings, desires, and vulnerabilities.
- Support: Being there emotionally, mentally, and sometimes physically.
- Affection: Expressing love and care through words, actions, or physical touch.

# INITIAL STAT RULES:
- Each stat is a percentage from -100% to 100%
- A stat of 0% means neutral/undeveloped
- Initial values should reflect first impressions and early interactions
- Values can range more broadly than scene-to-scene changes (this is an initial assessment)
- A dynamic title should capture the character's starting relationship role/attitude toward {{user}}

RESPONSE FORMAT — return ONLY valid JSON:
{
  "sceneSummary": "Concise summary of the scene...",
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
      "narrativeSummary": "2-3 sentence relationship trajectory assessment"
    }
  }
}`;
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
    parts.push("CHARACTERS IN THIS SCENE (stats represent character → {{user}} perspective):");
    for (const char of characters) {
        parts.push(`- ${char.name}`);
    }
    parts.push("");

    // Scene messages
    parts.push("SCENE MESSAGES:");
    messages.forEach((m, i) => {
        const speaker = m.name || "Unknown";
        const text = m.mes || "";
        const isUser = m.is_user ? " [USER]" : "";
        parts.push(`[${i}]${isUser} ${speaker}: ${text}`);
    });

    return parts.join("\n");
}

/**
 * Parse the initial stat response.
 * @param {string} response - LLM output
 * @param {Array} characters - Character profiles
 * @returns {{sceneSummary: string, characterUpdates: Array}}
 */
function parseInitialStatResponse(response, characters) {
    let parsed;
    try {
        parsed = JSON.parse(response.trim());
    } catch {
        const preview = (response || "").substring(0, 200);
        console.debug("[RST] Batch scan: Initial stat raw response preview:", preview);
        const match = response.match(/\{[\s\S]*\}/);
        if (match) {
            try {
                parsed = JSON.parse(match[0]);
            } catch {
                console.error("[RST] Batch scan: Failed to parse initial stat response as JSON. finish_reason may be 'length' — try increasing max tokens.");
                return { sceneSummary: "", characterUpdates: [] };
            }
        } else {
            console.error("[RST] Batch scan: No JSON found in initial stat response. Response may be empty due to token limit.");
            return { sceneSummary: "", characterUpdates: [] };
        }
    }

    const sceneSummary = parsed.sceneSummary || "";
    const characterUpdates = [];

    for (const char of characters) {
        const charData = parsed.characters?.[char.name];
        if (!charData || !charData.stats) continue;

        const statsAfter = {};
        for (const cat of STAT_CATEGORIES) {
            statsAfter[cat] = {};
            for (const stat of STAT_NAMES) {
                const val = charData.stats[cat]?.[stat];
                statsAfter[cat][stat] = typeof val === "number" ? Math.max(-100, Math.min(100, val)) : 0;
            }
        }

        characterUpdates.push({
            characterId: char.id,
            characterName: char.name,
            statsBefore: null, // No previous stats for initial
            statsAfter,
            commentary: charData.commentary || {},
            dynamicTitleBefore: "",
            dynamicTitleAfter: charData.dynamicTitle || "",
            milestoneReached: false,
            milestoneDetail: "",
            narrativeSummary: charData.narrativeSummary || "",
            source: "batch_scan",
            changeCount: 12, // All 12 stats are "new"
        });
    }

    return { sceneSummary, characterUpdates };
}
