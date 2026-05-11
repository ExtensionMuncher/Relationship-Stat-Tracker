/**
 * batchScan.js — Full chat history batch scan
 * Scans existing chat history, auto-detects scene boundaries, identifies characters,
 * creates profiles for unknown names, and generates initial scene summaries + stat blocks.
 *
 * Non-compounding: Skips message ranges already covered by existing scenes.
 */

import { chat } from "../../../../../script.js";
import { getContext } from "../../../../extensions.js";
import { makeRequest, reportProgress, updateRateLimiterSettings } from "./connections.js";
import { getSettings } from "../data/storage.js";
import { getScenes, saveScenes } from "../data/storage.js";
import { findCharacterByName, findCharacterByFuzzyName, createCharacter, updateCharacterStats, getCharacterProfile, addUpdateLogEntry, updateCharacterProfile, getAllCharacters, STAT_CATEGORIES, STAT_NAMES } from "../data/characters.js";
import { initSceneCounter, updateSceneSummary, updateSceneTitle } from "../data/scenes.js";
import { showPanelLoading, hidePanelLoading } from "../ui/panel.js";

// ─── Constants ─────────────────────────────────────────────

const EXCLUDED_NAMES = new Set(["{{user}}", "user", "User"]);

/**
 * Normalize a name for comparison by stripping parenthetical annotations,
 * normalizing diacritics (ō -> o, ū -> u, etc.), and lowercasing.
 * This allows LLM-returned names like "Satoru Gojō" or "Ryōmen Sukuna (referenced)"
 * to match chat speaker names like "Satoru Gojo" or "Ryomen Sukuna".
 * @param {string} name
 * @returns {string} Normalized name, or empty string if name is invalid.
 */
function normalizeNameForComparison(name) {
    if (!name) return "";
    let cleaned = name
        // Strip parenthetical annotations: "(referenced)", "(Sukuna)", etc.
        .replace(/\s*\([^)]*\)\s*/g, "")
        .trim();
    if (!cleaned) return "";
    // Normalize Unicode diacritics: decompose (NFD) then strip combining marks
    cleaned = cleaned.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return cleaned.toLowerCase().trim();
}

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

    // Sync rate limiter settings before starting
    updateRateLimiterSettings(settings.batchScan || {});

    const scanStartTime = Date.now();
    const bsSettings = settings.batchScan || {};

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

    // ─── Existing-stats guard ─────────────────────────────
    // Prevent batch scan from overwriting existing character stats with absolute values.
    // Batch scan generates absolute stat values (-100 to 100) which would obliterate any
    // existing scene-derived deltas. If any character has non-zero stats, warn and abort.
    const allProfiles = getAllCharacters();
    const hasExistingStats = Object.values(allProfiles).some((profile) =>
        profile?.stats && Object.values(profile.stats).some((catStats) =>
            catStats && Object.values(catStats).some((val) => val !== 0)
        )
    );
    if (hasExistingStats) {
        toastr?.warning?.(
            "Batch scan cannot run on characters with existing relationship stats. " +
            "Batch scan generates absolute values that would overwrite incremental changes from scene updates. " +
            "Use individual scene processing for ongoing roleplays.",
            "RST Batch Scan",
            { timeOut: 0, extendedTimeOut: 0, closeButton: true, preventDuplicates: true }
        );
        hidePanelLoading();
        return { scenesCreated: 0, profilesCreated: [] };
    }

    showPanelLoading("Batch scan: Analyzing chat for scene boundaries...");

    const existingScenes = getScenes();

    // Respect ST's message hiding: only process visible (non-system) messages.
    // ST marks hidden messages with is_system=true, mirroring how ST's Generate()
    // builds coreChat = chat.filter(x => !x.is_system ...) for the context window.
    const allMessages = chat.filter(m => !m.is_system);
    console.log(`[RST] Processing ${allMessages.length} visible messages out of ${chat.length} total (${chat.length - allMessages.length} hidden)`);

    // Non-compounding: determine unprocessed message ranges (only within visible messages)
    const ranges = getUnprocessedRanges(existingScenes, allMessages.length, 0);
    if (ranges.length === 0) {
        toastr?.info?.("All messages already covered by existing scenes. Nothing to scan.");
        hidePanelLoading();
        return { scenesCreated: 0, profilesCreated: [] };
    }

    toastr?.info?.("Batch scan: Analyzing chat for scene boundaries...");

    // Calculate expected API calls for progress tracking
    // If combineRanges is enabled, Phase 1 makes 1 call (all ranges merged).
    // Otherwise, it makes 1 call per range (may be more if ranges are chunked >500).
    const combineRanges = bsSettings.combineRanges !== false;
    const expectedPhase1Calls = combineRanges ? 1 : ranges.length;
    let totalApiCalls = expectedPhase1Calls; // Will be updated after Phase 3 when we know Phase 4 count
    let completedApiCalls = 0;

    reportProgress({
        phase: 1, totalPhases: 4,
        label: "Detecting scenes",
        current: 0, total: totalApiCalls,
        detail: `Analyzing ${ranges.length} message range(s) for scene boundaries...`,
        elapsed: 0,
    });

    // Phase 1: Detect scenes via LLM (pass combineRanges flag)
    const detectedScenes = await detectScenes(allMessages, ranges, autoGenProfile, settings, combineRanges);
    completedApiCalls += 1; // Phase 1 counts as one progress step

    reportProgress({
        phase: 1, totalPhases: 4,
        label: "Scene detection complete",
        current: completedApiCalls, total: totalApiCalls,
        detail: `Detected ${detectedScenes.length} scenes across ${ranges.length} range(s)`,
        elapsed: Date.now() - scanStartTime,
    });
    console.log("[RST-DEBUG] Phase 1 complete. Detected scenes:", JSON.stringify(detectedScenes, null, 2));
    // Log unique character names found across all scenes
    const charNamesFromLLM = new Set();
    for (const s of detectedScenes) { for (const n of s.characters) charNamesFromLLM.add(n); }
    console.log("[RST-DEBUG] All character names from LLM:", [...charNamesFromLLM]);

    if (!detectedScenes || detectedScenes.length === 0) {
        toastr?.warning?.("Batch scan: No scenes detected in the chat history.");
        hidePanelLoading();
        return { scenesCreated: 0, profilesCreated: [] };
    }

    // Phase 2: Create profiles for unknown characters (filtering out {{user}} and resolved names)
    // Detect the user's persona name from chat messages
    const userNameFromChat = allMessages.find(m => m.is_user)?.name || "";
    const blacklistNames = (settings.nameBlacklist || []).map((n) => n.toLowerCase().trim()).filter(Boolean);
    const userNamesToExclude = new Set([...EXCLUDED_NAMES, userNameFromChat, ...blacklistNames]);
    const profilesCreated = [];
    const allCharNames = new Set();

    // Build a set of all actual speaker names from the chat messages (normalized).
    const chatSpeakerNames = new Set();
    for (const msg of allMessages) {
        if (msg.name && !msg.is_user) {
            chatSpeakerNames.add(normalizeNameForComparison(msg.name));
        }
    }
    console.log("[RST-DEBUG] chatSpeakerNames:", [...chatSpeakerNames]);

    // --- Multi-character RP detection ---
    // In multi-character roleplay, a single {{char}} card generates ALL character dialogue,
    // so every assistant message has msg.name = the character card's display name
    // (e.g., "JJK High School AU RPG"). Individual character names like "Sukuna", "Gojō"
    // never appear as sender names in message metadata.
    //
    // We detect this scenario: if there's only 1 unique non-user speaker name but the LLM
    // detected multiple distinct character names, we're in a multi-character RP.
    // In that case, we trust the LLM's character detection (it reads message *content*)
    // rather than filtering against speaker names.
    const uniqueSpeakers = chatSpeakerNames.size;
    const llmDetectedCharCount = new Set();
    for (const scene of detectedScenes) {
        for (const n of scene.characters) {
            const clean = normalizeNameForComparison(n);
            if (clean) llmDetectedCharCount.add(clean);
        }
    }
    const isMultiCharRP = uniqueSpeakers <= 1 && llmDetectedCharCount.size > 1;
    console.log(`[RST-DEBUG] Multi-character RP detection: uniqueSpeakers=${uniqueSpeakers}, llmDetectedNames=${llmDetectedCharCount.size}, isMultiCharRP=${isMultiCharRP}`);

    if (isMultiCharRP) {
        // Multi-character RP: trust the LLM's character detection from message content.
        // The LLM scene detection prompt already excludes {{user}}, so just filter excluded names.
        console.log("[RST-DEBUG] Multi-character RP detected — trusting LLM character names, bypassing speaker-name filter.");
        for (const scene of detectedScenes) {
            for (const name of scene.characters) {
                if (userNamesToExclude.has(name)) continue;
                if (userNamesToExclude.has(name.toLowerCase())) continue;
                const cleanName = normalizeNameForComparison(name);
                if (!cleanName) continue;
                console.log(`[RST-DEBUG] Phase2 (multi-char): accepting name="${name}" -> clean="${cleanName}"`);
                allCharNames.add(name);
            }
        }
    } else {
        // Single-character RP (or ambiguous): use speaker-name verification filter.
        // This prevents descriptive {{char}} titles (e.g., "Fantasy AU RPG") from being
        // treated as character names, while preserving legitimate character names like
        // "Gojo Satoru" that DO appear as message senders.
        for (const scene of detectedScenes) {
            for (const name of scene.characters) {
                if (userNamesToExclude.has(name)) continue;
                if (userNamesToExclude.has(name.toLowerCase())) continue;
                const cleanName = normalizeNameForComparison(name);
                const found = chatSpeakerNames.has(cleanName);
                console.log(`[RST-DEBUG] Phase2 check: name="${name}" -> clean="${cleanName}" -> found=${found}`);
                if (!cleanName || !found) continue;
                allCharNames.add(name);
            }
        }
    }
    console.log("[RST-DEBUG] Phase 2: Character names to create profiles for:", [...allCharNames]);

    for (const name of allCharNames) {
        const existing = findCharacterByFuzzyName(name) || findCharacterByName(name);
        if (!existing) {
            const newProfile = createCharacter(name, { source: "auto_generated" });
            profilesCreated.push(name);
            console.log(`[RST-DEBUG] Created character profile: "${name}" -> id: ${newProfile?.id}`);
        } else {
            console.log(`[RST-DEBUG] Character already exists: "${name}" -> id: ${existing.id}`);
        }
    }
    console.log("[RST-DEBUG] Profiles created:", profilesCreated);

    // Phase 3: Create scene objects
    const createdScenes = [];
    initSceneCounter(); // Ensure counter is up-to-date

    for (const detected of detectedScenes) {
        const charIds = detected.characters
            .map((name) => {
                const profile = findCharacterByFuzzyName(name) || findCharacterByName(name);
                if (!profile) {
                    console.warn(`[RST-DEBUG] findCharacterByName returned null for "${name}"`);
                }
                return profile ? profile.id : null;
            })
            .filter(Boolean);
        console.log(`[RST-DEBUG] Scene ${detected.messageStart}-${detected.messageEnd}: characters=${JSON.stringify(detected.characters)} -> charIds=${JSON.stringify(charIds)}`);

        // Determine if {{user}} (resolved persona name) is present in this scene.
        // If the persona name is "{{user}}" or empty (can't resolve), default to true
        // since the parser strips "{{user}}" from scene characters before Phase 3.
        let hasUserInteraction = true;
        if (userNameFromChat && !EXCLUDED_NAMES.has(userNameFromChat)) {
            hasUserInteraction = detected.characters.some(name => name === userNameFromChat);
        }
        console.log(`[RST-DEBUG] Scene ${detected.messageStart}-${detected.messageEnd}: hasUserInteraction=${hasUserInteraction} (userNameFromChat="${userNameFromChat}")`);

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
            hasUserInteraction,
        };

        scenes.push(newScene);
        saveScenes(scenes);
        createdScenes.push(newScene);
    }

    // Sync module-level scene counter so manual scene creation continues from the correct number
    initSceneCounter();

    // ─── Phase 4: Generate summaries + initial stat blocks ──
    // Update total API calls now that we know how many scenes need stat generation
    const scenesNeedingStats = createdScenes.filter(s => s.hasUserInteraction);
    const totalPhase4Calls = scenesNeedingStats.length;
    totalApiCalls = expectedPhase1Calls + totalPhase4Calls;

    reportProgress({
        phase: 3, totalPhases: 4,
        label: "Creating scenes",
        current: completedApiCalls, total: totalApiCalls,
        detail: `${createdScenes.length} scene objects created. ${totalPhase4Calls} scenes need stat generation.`,
        elapsed: Date.now() - scanStartTime,
    });

    // Inter-phase delay between scene creation (Phase 3) and stat generation (Phase 4)
    const interPhaseDelay = bsSettings.interPhaseDelay || 0;
    if (interPhaseDelay > 0) {
        console.log(`[RST] Inter-phase delay: waiting ${interPhaseDelay}ms before Phase 4...`);
        reportProgress({
            phase: 3, totalPhases: 4,
            label: "Inter-phase cool-down",
            current: completedApiCalls, total: totalApiCalls,
            detail: `Waiting ${interPhaseDelay}ms before generating stats...`,
            elapsed: Date.now() - scanStartTime,
        });
        await new Promise(r => setTimeout(r, interPhaseDelay));
    }

    const perSceneDelay = bsSettings.perSceneDelay || 0;
    let scenesProcessed = 0;
    for (let sceneIdx = 0; sceneIdx < createdScenes.length; sceneIdx++) {
        const scene = createdScenes[sceneIdx];
        try {
            toastr?.info?.(`Batch scan: Processing scene ${scene.id} (${scene.messageStart}-${scene.messageEnd})...`);

            // Skip stat generation for scenes without {{user}} interaction
            if (!scene.hasUserInteraction) {
                console.log(`[RST] Scene ${scene.id} (${scene.messageStart}-${scene.messageEnd}): No {{user}} interaction — saving scene as reference only, skipping stat generation.`);
                updateSceneSummary(scene.id, "(Reference only — no direct {{user}} interaction in this scene)");
                scenesProcessed++;
                continue;
            }

            // Filter out hidden (is_system) messages from the scene data sent to the LLM
            const sceneMessages = allMessages.slice(scene.messageStart, scene.messageEnd + 1).filter(m => !m.is_system);
            const characters = scene.charactersPresent
                .map((id) => getCharacterProfile(id))
                .filter(Boolean);

            if (sceneMessages.length === 0 || characters.length === 0) {
                // Count as completed even though no API call was made (progress tracking consistency)
                completedApiCalls++;
                reportProgress({
                    phase: 4, totalPhases: 4,
                    label: "Generating stats",
                    current: completedApiCalls, total: totalApiCalls,
                    detail: `[${completedApiCalls - expectedPhase1Calls}/${totalPhase4Calls}] ${scene.id}: No data to process`,
                    elapsed: Date.now() - scanStartTime,
                });
                scenesProcessed++;
                continue;
            }

            reportProgress({
                phase: 4, totalPhases: 4,
                label: "Generating stats",
                current: completedApiCalls, total: totalApiCalls,
                detail: `[${completedApiCalls - expectedPhase1Calls + 1}/${totalPhase4Calls}] Processing ${scene.id} (messages ${scene.messageStart}-${scene.messageEnd})...`,
                elapsed: Date.now() - scanStartTime,
            });

            const result = await generateInitialStats(sceneMessages, characters, statUpdateProfile, settings);

            completedApiCalls++;

            // Save scene summary
            if (result.sceneSummary) {
                updateSceneSummary(scene.id, result.sceneSummary);
            }

            // Save scene title (if generated)
            if (result.sceneTitle) {
                updateSceneTitle(scene.id, result.sceneTitle);
            }

            // Apply initial stats + save commentary/log to character profiles
            for (const charUpdate of result.characterUpdates) {
                const profile = getCharacterProfile(charUpdate.characterId);
                if (profile) {
                    updateCharacterStats(charUpdate.characterId, charUpdate.statsAfter);

                    // Save narrative summary and dynamic title
                    if (charUpdate.narrativeSummary) {
                        updateCharacterProfile(charUpdate.characterId, { narrativeSummary: charUpdate.narrativeSummary });
                    }
                    if (charUpdate.dynamicTitleAfter) {
                        updateCharacterProfile(charUpdate.characterId, { dynamicTitle: charUpdate.dynamicTitleAfter });
                    }

                    // Log the update with commentary
                    addUpdateLogEntry(charUpdate.characterId, {
                        timestamp: Date.now(),
                        statsBefore: charUpdate.statsBefore || {},
                        statsAfter: charUpdate.statsAfter,
                        commentary: charUpdate.commentary || {},
                        sceneId: scene.id,
                        source: "batch_scan",
                    });
                }
            }

            // Report progress after successful scene processing
            reportProgress({
                phase: 4, totalPhases: 4,
                label: "Generating stats",
                current: completedApiCalls, total: totalApiCalls,
                detail: `[${completedApiCalls - expectedPhase1Calls}/${totalPhase4Calls}] ${scene.id}: Complete`,
                elapsed: Date.now() - scanStartTime,
            });

            scenesProcessed++;

            // Per-scene delay (skip after the last scene)
            if (perSceneDelay > 0 && sceneIdx < createdScenes.length - 1) {
                console.log(`[RST] Per-scene delay: waiting ${perSceneDelay}ms before next scene...`);
                await new Promise(r => setTimeout(r, perSceneDelay));
            }
        } catch (err) {
            console.error(`[RST] Batch scan: Failed to process scene ${scene.id}:`, err);
        }
    }

    hidePanelLoading();
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
async function detectScenes(allMessages, ranges, profileName, settings, combineRanges = false) {
    const systemPrompt = buildSceneDetectionSystemPrompt();
    const maxTokens = settings.batchScan?.sceneDetectionMaxTokens ?? 6000;
    const MAX_UNCHUNKED_SIZE = 500; // Safety guard: only chunk ranges > 500 messages
    const allScenes = [];

    // When combineRanges is enabled, merge all small ranges into a single API call
    // Build blacklist set for scene detection character filtering
    const _blacklistNames = (settings.nameBlacklist || []).map((n) => n.toLowerCase().trim()).filter(Boolean);
    const _sceneBlacklist = new Set(_blacklistNames);

    if (combineRanges && ranges.length > 1) {
        const totalMessages = ranges.reduce((sum, r) => sum + (r.end - r.start + 1), 0);
        if (totalMessages <= MAX_UNCHUNKED_SIZE) {
            console.log(`[RST] Combining ${ranges.length} ranges (${totalMessages} total messages) into single scene detection call.`);
            const requestPrompt = buildSceneDetectionRequest(allMessages, ranges);
            const result = await makeRequest(profileName, systemPrompt, requestPrompt, maxTokens);
            if (result) {
                console.log(`[RST-DEBUG] Scene detection LLM response (combined ${ranges.length} ranges):`, result.substring(0, 500));
                const parsed = parseSceneDetectionResponse(result, ranges, _sceneBlacklist);
                console.log(`[RST-DEBUG] Parsed scenes from combined ranges:`, JSON.stringify(parsed.map(s => ({ start: s.messageStart, end: s.messageEnd, chars: s.characters }))));
                allScenes.push(...parsed);
            }
            return allScenes;
        }
        console.log(`[RST] Combined ranges skipped: ${totalMessages} total messages exceeds ${MAX_UNCHUNKED_SIZE}. Processing per-range.`);
    }

    for (const range of ranges) {
        const messageCount = range.end - range.start + 1;

        if (messageCount <= MAX_UNCHUNKED_SIZE) {
            // Send the full range in a single LLM call for natural boundary detection
            // This avoids artificial cuts at fixed intervals
            const requestPrompt = buildSceneDetectionRequest(allMessages, [range]);
            const result = await makeRequest(profileName, systemPrompt, requestPrompt, maxTokens);
            if (result) {
                console.log(`[RST-DEBUG] Scene detection LLM response (range ${range.start}-${range.end}):`, result.substring(0, 500));
                const parsed = parseSceneDetectionResponse(result, [range], _sceneBlacklist);
                console.log(`[RST-DEBUG] Parsed scenes from range ${range.start}-${range.end}:`, JSON.stringify(parsed.map(s => ({start: s.messageStart, end: s.messageEnd, chars: s.characters}))));
                allScenes.push(...parsed);
            }
        } else {
            // Very large range: use overlapping windows for context continuity
            const OVERLAP = 10; // Include last 10 messages of previous window
            for (let cs = range.start; cs <= range.end; cs += (MAX_UNCHUNKED_SIZE - OVERLAP)) {
                const ce = Math.min(cs + MAX_UNCHUNKED_SIZE - 1, range.end);
                const windowRange = { start: cs, end: ce };
                const requestPrompt = buildSceneDetectionRequest(allMessages, [windowRange]);
                const result = await makeRequest(profileName, systemPrompt, requestPrompt, maxTokens);
                if (result) {
                    console.log(`[RST-DEBUG] Scene detection LLM response (window ${cs}-${ce}):`, result.substring(0, 500));
                    // Only take scenes within the non-overlapping portion
                    const nonOverlapStart = cs + (cs > range.start ? OVERLAP : 0);
                    const parsed = parseSceneDetectionResponse(result, [windowRange], _sceneBlacklist);
                    console.log(`[RST-DEBUG] Parsed window scenes:`, JSON.stringify(parsed.map(s => ({start: s.messageStart, end: s.messageEnd, chars: s.characters}))));
                    const windowScenes = parsed.filter((s) => s.messageStart >= nonOverlapStart);
                    allScenes.push(...windowScenes);
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
A "scene" is a substantial narrative unit with a consistent setting, time period, and group of interacting characters. Scenes represent meaningful story segments where characters interact, develop, and drive the plot forward. Scene boundaries occur when:
- The topic or activity changes significantly
- Characters enter or leave
- There's a notable time skip or location change

# CRITICAL — MINIMUM SCENE SIZE:
- Each scene MUST span at least 15 messages. Do not create scenes shorter than 15 messages.
- If a group of messages is too short to form a proper scene, merge it with adjacent messages or leave it unmarked.
- Only create scene boundaries where there's a clear, meaningful narrative shift.
- Avoid fragmenting conversations into many tiny scenes — scenes should represent real story arcs.

# RULES:
- Scenes must not overlap
- Scene boundaries should be clean message breaks (whole messages)
- Identify characters by reading the message CONTENT — list each distinct character who appears or is actively participating, regardless of the sender label. In multi-character roleplay, all messages may share the same sender label (the {{char}} card name), so you MUST infer characters from what is written.
- Exclude "{{user}}" or "User" from the character list — only list non-user characters
- Exclude descriptive titles or narrative descriptors (e.g., "the narrator", "storyteller") — only list actual character names

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
            if (m.is_system) continue; // Skip hidden/context-excluded messages
            const speaker = m.name || "Unknown";
            const text = (m.mes || "");
            parts.push(`[${i}] ${speaker}: ${text}`);
        }
        parts.push("");
    }

    // Schema reminder + character completeness
    parts.push('');
    parts.push('Also scan the messages for ALL characters who speak, appear, or are referenced. List every one of them.');
    parts.push('Return JSON only: {"scenes": [{"messageStart": <int>, "messageEnd": <int>, "characters": ["Name1", ...]}]}');

    return parts.join("\n");
}

/**
 * Parse the LLM scene detection response.
 * Uses multi-strategy cascade to handle various output formats.
 * @param {string} response
 * @param {Array<{start: number, end: number}>} ranges - Valid message ranges
 * @param {Set<string>} [blacklistSet] - Optional set of blacklisted names to exclude
 * @returns {Array<{messageStart: number, messageEnd: number, characters: string[]}>}
 */
function parseSceneDetectionResponse(response, ranges, blacklistSet = new Set()) {
    const parsed = extractSceneDetectionJson(response);
    if (!parsed || !parsed.scenes || !Array.isArray(parsed.scenes)) {
        // If JSON extraction failed, try analysis-text fallback
        const fallback = parseSceneDetectionAnalysisText(response, ranges);
        if (fallback && fallback.length > 0) {
            console.log("[RST] Batch scan: Scene detection via analysis-text fallback succeeded");
            return fallback;
        }
        const preview = (response || "").substring(0, 200);
        console.debug("[RST] Batch scan: Scene detection raw response preview:", preview);
        const msg = "[RST] Batch scan: No JSON found in scene detection response.";
        console.error(msg);
        toastr?.error?.("Batch scan: No scene data found in the LLM response.", "RST Batch Scan");
        return [];
    }

    // Validate and constrain scene boundaries to the requested ranges
    const MIN_SCENE_SIZE = 15;
    const validScenes = [];
    for (const scene of parsed.scenes) {
        const start = parseInt(scene.messageStart, 10);
        const end = parseInt(scene.messageEnd, 10);

        if (isNaN(start) || isNaN(end) || start < 0 || end < start) continue;

        // Enforce minimum scene size
        const sceneSize = end - start + 1;
        if (sceneSize < MIN_SCENE_SIZE) continue;

        // Ensure scene falls within at least one valid range
        const inRange = ranges.some((r) => start >= r.start && end <= r.end);
        if (!inRange) continue;

        // Filter EXCLUDED_NAMES + blacklist from characters (case-insensitive)
        // Keep original characters reference for downstream {{user}} presence checks
        const characters = (Array.isArray(scene.characters) ? scene.characters : [])
            .filter((name) => {
                const n = name.toLowerCase().trim();
                return !EXCLUDED_NAMES.has(name) && !EXCLUDED_NAMES.has(name.toLowerCase()) && !blacklistSet.has(n);
            });

        validScenes.push({
            messageStart: start,
            messageEnd: end,
            characters,
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

/**
 * Multi-strategy JSON extraction for scene detection responses.
 * Strategies: direct -> json fence -> generic fence -> greedy braces -> progressive trim -> truncated repair
 * @param {string} text - Raw LLM response
 * @returns {object|null}
 */
function extractSceneDetectionJson(text) {
    if (!text) return null;
    const clean = text.trim();

    // Strategy 1: Direct JSON parse
    try {
        const parsed = JSON.parse(clean);
        if (parsed && parsed.scenes) return parsed;
    } catch { /* continue */ }

    // Strategy 2: Extract from ```json ... ``` code fence
    const jsonFence = clean.match(/```json\s*([\s\S]*?)```/);
    if (jsonFence) {
        try {
            const parsed = JSON.parse(jsonFence[1].trim());
            if (parsed && parsed.scenes) return parsed;
        } catch { /* continue */ }
    }

    // Strategy 3: Extract from ``` ... ``` generic fence
    const fence = clean.match(/```\s*([\s\S]*?)```/);
    if (fence) {
        try {
            const parsed = JSON.parse(fence[1].trim());
            if (parsed && parsed.scenes) return parsed;
        } catch { /* continue */ }
    }

    // Strategy 4: Greedy regex { ... } extraction
    const braceMatch = clean.match(/\{[\s\S]*\}/);
    if (braceMatch) {
        try {
            const parsed = JSON.parse(braceMatch[0]);
            if (parsed && parsed.scenes) return parsed;
        } catch { /* continue */ }
    }

    // Strategy 5: Progressive trimming from last } backward
    for (let end = clean.lastIndexOf('}'); end > clean.indexOf('{'); end = clean.lastIndexOf('}', end - 1)) {
        const start = clean.indexOf('{');
        if (start >= 0 && end > start) {
            try {
                const parsed = JSON.parse(clean.substring(start, end + 1));
                if (parsed && parsed.scenes) return parsed;
            } catch { continue; }
        }
    }

    // Strategy 6: Truncated JSON repair (starts with { but cut off)
    if (clean.startsWith('{') && !clean.trim().endsWith('}')) {
        try {
            const titleMatch = clean.match(/"sceneTitle"\s*:\s*"((?:[^"\\]|\\.)*)"/);
            const summaryMatch = clean.match(/"sceneSummary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
            if (titleMatch || summaryMatch) {
                return { scenes: [] }; // Minimal valid response
            }
        } catch { /* continue */ }
    }

    return null;
}

/**
 * Fallback: parse scene detection data from analysis text format.
 * Handles GLM 4.7 output like:
 *   1. **Scene 1:**
 *      * **Message Range:** 0-18
 *      * **Characters:** Alice, Bob
 *   2. **Scene 2:**
 *      * **Message Range:** 19-35
 *      * **Characters:** Alice, Charlie
 * @param {string} text - Raw LLM response
 * @param {Array<{start: number, end: number}>} ranges - Valid message ranges
 * @returns {Array<{messageStart: number, messageEnd: number, characters: string[]}>}
 */
function parseSceneDetectionAnalysisText(text, ranges) {
    try {
        const scenes = [];
        const MIN_SCENE_SIZE = 15;

        // Match scene blocks: **Scene N:** ... or N. **Scene Title:** ...
        const scenePattern = /(?:\d+\.\s*)?\*{1,2}\s*Scene\s+\d+\s*\*{1,2}\s*:?/gi;
        const segments = text.split(scenePattern);

        // Skip first segment (text before first scene)
        for (let i = 1; i < segments.length; i++) {
            const block = segments[i];

            // Extract message range: * **Message Range:** start-end or * **Messages:** start-end
            const rangeMatch = block.match(/(?:Message Range|Messages)\s*:?\s*(\d+)\s*[-to]+\s*(\d+)/i);
            if (!rangeMatch) continue;

            const start = parseInt(rangeMatch[1], 10);
            const end = parseInt(rangeMatch[2], 10);
            if (isNaN(start) || isNaN(end) || end - start + 1 < MIN_SCENE_SIZE) continue;

            // Extract characters: * **Characters:** Name1, Name2, ...
            const charsMatch = block.match(/(?:Characters|Character(?:s)?)\s*:?\s*([\s\S]*?)(?:\n\s*(?:\d+\.|\*{1,2}|\n)|$)/i);
            const characters = [];
            if (charsMatch) {
                const raw = charsMatch[1].trim();
                // Split by comma or bullet points
                const names = raw.split(/[,•*]+/).map((n) => n.trim().replace(/^["'\*]*|["'\*]*$/g, '')).filter(Boolean);
                for (const name of names) {
                    const clean = name.replace(/\*+/g, '').trim();
                    if (clean && !EXCLUDED_NAMES.has(clean) && !EXCLUDED_NAMES.has(clean.toLowerCase())) {
                        characters.push(clean);
                    }
                }
            }

            if (characters.length > 0) {
                scenes.push({ messageStart: start, messageEnd: end, characters });
            }
        }

        // Sort by messageStart and remove overlaps
        scenes.sort((a, b) => a.messageStart - b.messageStart);
        const nonOverlapping = [];
        let lastEnd = -1;
        for (const scene of scenes) {
            if (scene.messageStart > lastEnd) {
                nonOverlapping.push(scene);
                lastEnd = scene.messageEnd;
            }
        }

        return nonOverlapping;
    } catch (err) {
        console.warn("[RST] Scene detection analysis-text fallback failed:", err.message);
        return [];
    }
}

// ─── Non-Compounding Check ────────────────────────────────

/**
 * Determine which message ranges are not yet covered by existing scenes.
 * @param {Array} existingScenes - Current scene entries
 * @param {number} totalMessages - Total number of chat messages
 * @returns {Array<{start: number, end: number}>} Unprocessed ranges
 */
function getUnprocessedRanges(existingScenes, totalMessages, startIdx = 0) {
    if (existingScenes.length === 0) {
        return [{ start: startIdx, end: totalMessages - 1 }];
    }

    // Collect all covered message indices
    // Messages before startIdx are treated as covered (not visible in context window)
    const covered = new Set();
    for (let i = 0; i < startIdx; i++) {
        covered.add(i);
    }
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
 * @returns {Promise<{sceneSummary: string, sceneTitle: string, characterUpdates: Array}>}
 */
async function generateInitialStats(messages, characters, profileName, settings) {
    const systemPrompt = buildInitialStatSystemPrompt(settings);
    const requestPrompt = buildInitialStatRequestPrompt(messages, characters, settings);

    const maxTokens = settings.batchScan?.initialStatMaxTokens ?? 3000;
    const result = await makeRequest(profileName, systemPrompt, requestPrompt, maxTokens);
    if (!result) {
        return { sceneSummary: "", sceneTitle: "", characterUpdates: [] };
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
2. A SCENE TITLE (short, descriptive name for this scene)
3. For each character, an INITIAL relationship stat assessment based on their behavior in the scene

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
  "sceneTitle": "Short descriptive title for this scene",
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

    parts.push(`SCENE SUMMARY INSTRUCTIONS:\n${settings.sceneSummaryPrompt || ""}`);
    parts.push("");

    // Character list
    const userName = getContext().name1 || "User";
    parts.push(`CHARACTERS IN THIS SCENE (stats represent character → {{user}} perspective):`);
    for (const char of characters) {
        parts.push(`- ${char.name}`);
    }
    parts.push("");

    // Scene messages
    parts.push(`SCENE MESSAGES ("${userName}" is the user/player, all other named speakers are characters):`);
    messages.forEach((m, i) => {
        const speaker = m.name || "Unknown";
        const text = m.mes || "";
        const isUser = m.is_user ? " [USER]" : "";
        parts.push(`[${i}]${isUser} ${speaker}: ${text}`);
    });

    // Character discovery instruction
    parts.push('');
    parts.push('Also scan the messages for ANY additional characters (named individuals) who appear, speak, or are referenced. Include them in your characters object with full stat updates using the same schema.');
    parts.push('');

    // Clean close
    parts.push('Return JSON only.');

    return parts.join("\n");
}

/**
 * Parse the initial stat response.
 * @param {string} response - LLM output
 * @param {Array} characters - Character profiles
 * @returns {{sceneSummary: string, sceneTitle: string, characterUpdates: Array}}
 */
function parseInitialStatResponse(response, characters) {
    // Try robust JSON extraction first (handles code fences, truncation)
    const parsed = extractBatchStatJson(response);
    if (!parsed) {
        const preview = (response || "").substring(0, 200);
        const msg = `[RST] Batch scan: Could not parse initial stat response. Preview: "${preview}"`;
        console.warn(msg);
        toastr?.error?.("Batch scan: Could not parse the stat generation response. The LLM may have returned malformed JSON.", "RST Batch Scan");
        return { sceneSummary: "", sceneTitle: "", characterUpdates: [] };
    }

    const sceneSummary = parsed.sceneSummary || "";
    const sceneTitle = parsed.sceneTitle || "";
    const characterUpdates = [];

    // Process known characters from input list
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
            statsBefore: null,
            statsAfter,
            commentary: charData.commentary || {},
            dynamicTitleBefore: "",
            dynamicTitleAfter: charData.dynamicTitle || "",
            milestoneReached: false,
            milestoneDetail: "",
            narrativeSummary: charData.narrativeSummary || "",
            source: "batch_scan",
            changeCount: 12,
        });
    }

    // Handle LLM-discovered characters (in parsed.characters but not in input list)
    if (parsed && parsed.characters) {
        const inputNames = new Set(characters.map(c => c.name));
        for (const [llmName, llmData] of Object.entries(parsed.characters)) {
            if (!inputNames.has(llmName) && llmData && llmData.stats) {
                console.log("[RST] Batch scan: LLM discovered additional character:", llmName);
                const newChar = createCharacter(llmName, { source: "auto_generated" });
                if (newChar) {
                    const statsAfter = {};
                    for (const cat of STAT_CATEGORIES) {
                        statsAfter[cat] = {};
                        for (const stat of STAT_NAMES) {
                            const val = llmData.stats[cat]?.[stat];
                            statsAfter[cat][stat] = typeof val === "number" ? Math.max(-100, Math.min(100, val)) : 0;
                        }
                    }
                    characterUpdates.push({
                        characterId: newChar.id,
                        characterName: newChar.name,
                        statsBefore: null,
                        statsAfter,
                        commentary: llmData.commentary || {},
                        dynamicTitleBefore: "",
                        dynamicTitleAfter: llmData.dynamicTitle || "",
                        milestoneReached: false,
                        milestoneDetail: "",
                        narrativeSummary: llmData.narrativeSummary || "",
                        source: "batch_scan_discovered",
                        changeCount: 12,
                    });
                }
            }
        }
    }

    return { sceneSummary, sceneTitle, characterUpdates };
}

// ─── JSON Extraction Helper ─────────────────────────────────

/**
 * Strip markdown code fences and attempt to extract JSON from a batch scan LLM response.
 * Handles ```json ... ```, ``` ... ```, and truncated responses.
 * @param {string} text - Raw LLM response
 * @returns {object|null} Parsed JSON or null if extraction failed
 */
function extractBatchStatJson(text) {
    if (!text) return null;
    const clean = text.trim();

    // Strategy 1: Direct JSON parse
    try {
        const parsed = JSON.parse(clean);
        if (parsed && (parsed.sceneSummary || parsed.characters)) return parsed;
    } catch { /* continue */ }

    // Strategy 2: Strip ```json code fence
    const jsonFence = clean.match(/```json\s*([\s\S]*?)```/);
    if (jsonFence) {
        try {
            const parsed = JSON.parse(jsonFence[1].trim());
            if (parsed && (parsed.sceneSummary || parsed.characters)) return parsed;
        } catch { /* continue */ }
    }

    // Strategy 3: Strip generic ``` fence
    const fence = clean.match(/```\s*([\s\S]*?)```/);
    if (fence) {
        try {
            const parsed = JSON.parse(fence[1].trim());
            if (parsed && (parsed.sceneSummary || parsed.characters)) return parsed;
        } catch { /* continue */ }
    }

    // Strategy 4: Greedy regex { ... } extraction
    const braceMatch = clean.match(/\{[\s\S]*\}/);
    if (braceMatch) {
        try {
            const parsed = JSON.parse(braceMatch[0]);
            if (parsed && (parsed.sceneSummary || parsed.characters)) return parsed;
        } catch { /* continue */ }
    }

    // Strategy 5: Progressive trimming from last } backward
    for (let end = clean.lastIndexOf('}'); end > clean.indexOf('{'); end = clean.lastIndexOf('}', end - 1)) {
        const start = clean.indexOf('{');
        if (start >= 0 && end > start) {
            try {
                const parsed = JSON.parse(clean.substring(start, end + 1));
                if (parsed && (parsed.sceneSummary || parsed.characters)) return parsed;
            } catch { continue; }
        }
    }

    // Strategy 6: Truncated JSON repair — close unclosed strings and braces
    if (clean.startsWith('{') && !clean.trim().endsWith('}')) {
        try {
            const repaired = repairBatchTruncatedJson(clean);
            if (repaired) return repaired;
        } catch { /* continue */ }
    }

    // Strategy 7: Analysis-text fallback — parse bullet-point stats format
    try {
        const fallback = parseInitialStatAnalysisText(clean);
        if (fallback) {
            console.log("[RST] Batch stat: analysis-text fallback succeeded");
            return fallback;
        }
    } catch { /* fall through */ }

    return null;
}

/**
 * Fallback: parse initial stat data from analysis text format.
 * Handles GLM 4.7 output like:
 *   1. **Scene Title:** The Confrontation
 *   2. **Scene Summary:** Alice confronts Bob...
 *   3. **Character Stats (Alice -> User):**
 *      * **Platonic:** trust=30, openness=20...
 *      * **Romantic:** trust=10, openness=5...
 *      * **Sexual:** trust=0, openness=0...
 * @param {string} text - Raw LLM response
 * @returns {object|null} Parsed { sceneTitle, sceneSummary, characters } or null
 */
function parseInitialStatAnalysisText(text) {
    // Extract scene title
    let sceneTitle = "";
    const titleMatch = text.match(/(?:Scene Title|Title)\s*:?\s*["']?([^"'\n]+?)["']?(?:\n|$)/i);
    if (titleMatch) sceneTitle = titleMatch[1].trim();

    // Extract scene summary
    let sceneSummary = "";
    const summaryMatch = text.match(/(?:Scene Summary|Summary)\s*:?\s*["']?([^"'\n]+?)["']?(?:\n|$)/i);
    if (summaryMatch) sceneSummary = summaryMatch[1].trim();

    // Also try longer summary text (paragraph after "Scene Summary:" header)
    if (!sceneSummary) {
        const longSummary = text.match(/(?:Scene Summary|Summary)\s*:?\s*([\s\S]*?)(?:\n\s*(?:\d+\.|\*{1,2}|\n)|$)/i);
        if (longSummary) sceneSummary = longSummary[1].trim();
    }

    const characters = {};
    const categories = ['platonic', 'romantic', 'sexual'];
    const statNames = ['trust', 'openness', 'support', 'affection'];

    // Find character stat sections
    // Pattern: **Character Stats (Name -> User):** or **Name's Stats:** or similar
    const charSectionRegex = /(?:\*{1,2}\s*(?:Character Stats|Stats)\s*\(?\s*([^()\->\n]+?)\s*(?:->|–|:))/gi;
    let charMatch;
    while ((charMatch = charSectionRegex.exec(text)) !== null) {
        const charName = charMatch[1].trim();
        if (!charName || charName.toLowerCase() === 'user') continue;

        const sectionStart = charMatch.index;
        // Find next section boundary
        const nextSection = text.slice(sectionStart + 50).search(/(?:\d+\.\s*)?\*{1,2}\s*(?:Character Stats|Stats)\s*\(/i);
        const sectionEnd = nextSection >= 0 ? sectionStart + 50 + nextSection : text.length;
        const section = text.slice(sectionStart, sectionEnd);

        const stats = { platonic: {}, romantic: {}, sexual: {} };
        const commentary = { platonic: {}, romantic: {}, sexual: {} };

        for (const cat of categories) {
            // Match: **Platonic:** trust=30, openness=20...
            const catRegex = new RegExp('\\*{1,2}\\s*' + cat + '\\s*\\*{1,2}\\s*:?\\s*([^\\n]*(?:\\n[^\\*\\n][^\\n]*)*)', 'i');
            const catMatch = section.match(catRegex);
            if (!catMatch) continue;

            const catSection = catMatch[1];
            for (const stat of statNames) {
                // Match: trust=30 or trust:30 or trust=30% or trust:30%
                const statRegex = new RegExp(stat + '\\s*[=:]\\s*(-?\\d+)', 'i');
                const statMatch = catSection.match(statRegex);
                if (statMatch) {
                    const val = parseInt(statMatch[1], 10);
                    stats[cat][stat] = Math.max(-100, Math.min(100, val));
                } else {
                    stats[cat][stat] = 0;
                }
                commentary[cat][stat] = "";
            }
        }

        // Extract dynamic title if present
        let dynamicTitle = "";
        const dtMatch = section.match(/(?:Dynamic Title|Title)\s*:?\s*["']?([^"'\n]+?)["']?(?:\n|$)/i);
        if (dtMatch) dynamicTitle = dtMatch[1].trim();

        // Extract narrative summary if present
        let narrativeSummary = "";
        const nsMatch = section.match(/(?:Narrative Summary|Narrative)\s*:?\s*["']?([^"'\n]+?)["']?(?:\n|$)/i);
        if (nsMatch) narrativeSummary = nsMatch[1].trim();

        characters[charName] = {
            stats,
            commentary,
            dynamicTitle,
            narrativeSummary,
        };
    }

    if (Object.keys(characters).length > 0 || sceneSummary) {
        return { sceneTitle, sceneSummary, characters };
    }

    return null;
}

/**
 * Attempt to repair truncated JSON by balancing braces and closing unclosed strings.
 * Handles responses that are cut off mid-value (no closing brace).
 * @param {string} text - Partial JSON text starting from first {
 * @returns {object|null} Parsed object, or null if repair fails
 */
function repairBatchTruncatedJson(text) {
    // Count braces and track string state to compute what needs closing
    let braceDepth = 0;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\' && inString) { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') { braceDepth++; }
        if (ch === '}') { braceDepth--; }
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
