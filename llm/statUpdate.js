/**
 * statUpdate.js — Main LLM: scene review + stat generation
 * Reviews closed scenes, generates stat changes, commentary, dynamic titles,
 * narrative summaries, AND scene summaries (single LLM call)
 */

import { chat } from "../../../../../script.js";
import { getContext } from "../../../../extensions.js";
import { getPersonaContext } from "./connections.js";
import { makeRequest } from "./connections.js";
import { getSettings, isNameBlacklisted } from "../data/storage.js";
import { getCharacterProfile, getAllCharacters, findCharacterByName, findCharacterByFuzzyName, getCharacterNameVariants, cloneStats, STAT_CATEGORIES, STAT_NAMES, createCharacter, getSoftLockAvailability, getVisibleStatCategories, isStatCategoryVisible } from "../data/characters.js";
import { getSceneById, getAllSceneSummaries, updateSceneCharacters, updateSceneTitle, getClosedSceneCount, getClosedSceneCountForChar } from "../data/scenes.js";
import { dlog } from "../lib/debug.js";
import { deriveRelationshipTrajectory } from "../data/trajectory.js";
import { applyRelationshipInertia, getRelationshipInertiaContext } from "../data/inertia.js";
import { getRelationshipConditionCatalogForPrompt, getRelationshipConditionDefinition, MAX_ACTIVE_RELATIONSHIP_CONDITIONS, MAX_NEW_CONDITIONS_PER_UPDATE } from "../data/conditions.js";

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
                20000,
                0.3,
            );

            if (!resultText) throw new Error("No response from LLM");

            const parsed = parseStatUpdateResponse(resultText, existingChars, sceneMessages.length);
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
        '        "proposedMilestones": [{"title":"...","description":"...","domains":["platonic"]}],',
        '        "proposedConditions": [{"type":"guarded","reason":"why it is active now","resolution":"what would resolve it"}],',
        '        "resolvedConditions": [{"id":"condition id shown in current profile","reason":"why it resolved"}],',
        '        "dynamicTitle": "...",',
        '        "milestoneReached": false,',
        '        "criticalStats": ["category.stat for any stat where a narratively pivotal moment justifies an unusually large shift"],',
        '        "proposedHardLocks": [{"stat":"category.stat","cap":NUMBER,"reason":"why this character\'s psychology caps this stat here"}],',
        '        "proposedSoftLocks": [{"stat":"category.stat","cap":NUMBER,"condition":"what {{user}} must do to unlock further growth","progress":"current prose progress toward it"}],',
        '        "unlockedSoftLocks": ["category.stat for any EXISTING soft lock whose condition was fulfilled this scene"],',
        '        "softLockProgress": [{"stat":"category.stat","progress":"updated prose progress note for an existing, still-locked soft lock"}],',
        '        "hardLockPressureUpdates": [{"stat":"category.stat","change":-2|-1|0|1|2,"reason":"specific behavior that contradicts or reinforces the hard lock reason"}],',
        '        "hardLockReviews": [{"stat":"category.stat","recommendation":"maintain|raise_cap|convert_to_soft|remove","recommendedCap":NUMBER,"reason":"why the accumulated evidence justifies this"}],',
        '        "milestoneDetail": "...",',
        '        "narrativeSummary": "..."',
        '      }',
        '    }',
        '  }',
        '',
        'Rules:',
        '- Stats represent character\'s feelings toward {{user}}, not reverse.',
        '- Per-character category visibility is authoritative. If a character is shown with only some visible/active categories, ONLY output stats/commentary/criticalStats/locks/pressure/reviews for those visible categories. Do not infer, update, propose locks for, unlock, or mention hidden categories.',
        '- A character can be affected by a scene WITHOUT face-to-face interaction. If a character observes, surveils, directs, or remotely influences events involving {{user}} (even unknown to {{user}}), their feelings can still shift. Base their stat changes on what they witness, learn, or do from afar — e.g. watching {{user}} can deepen fixation (affection), build a sense of knowing them (openness), or erode/strengthen trust based on what is observed.',
        '- Asymmetric awareness is valid: only update a character based on what THAT character is aware of. If {{user}} does not know a character is involved, {{user}}-facing dynamics may be one-sided, and that is correct.',
        '- proposedMilestones: OPTIONAL and RARE. RST milestones are ONLY about THIS CHARACTER <-> {{user}}. Never create a milestone for a relationship/event between two NPCs or other characters. A milestone must materially and durably redefine how this character and {{user}} relate to each other: major rupture/reconciliation, explicit commitment or vow, decisive betrayal/rescue, serious boundary violation, or comparably consequential disclosure/action. A thank-you, meal, ordinary comfort/encouragement, first meeting, routine apology, generic fight, or single vulnerable line is NOT enough by itself. Most scenes have zero. At most 1 milestone per character per scene. Give a short factual title/description and relevant domains.',
        `- proposedConditions: OPTIONAL. Conditions are temporary contextual lenses, not permanent personality traits or buffs. At most ${MAX_NEW_CONDITIONS_PER_UPDATE} new condition per character per scene and never more than ${MAX_ACTIVE_RELATIONSHIP_CONDITIONS} active total. Allowed types: ${getRelationshipConditionCatalogForPrompt()}. Give why it is active and what specific narrative development should resolve it.`,
        '- resolvedConditions: ONLY for an active condition whose stated resolution has actually occurred in this scene. Use the exact condition id shown in CURRENT CHARACTER STATS and explain why it resolved.',
        '- Conditions influence how evidence should be interpreted, but NEVER override hard locks, soft locks, critical-change rules, or established personality. Example: Possessive can raise attention/affection without implying trust; Guarded can make ordinary warmth insufficient for openness.',
        '- criticalStats: list "category.stat" entries (e.g. "romantic.affection") ONLY for stats where a genuinely PIVOTAL, story-defining moment occurred this scene that would justify a much larger-than-usual shift — a confession, betrayal, rescue, profound vulnerability, or similar turning point. Be sparing: most scenes have ZERO critical stats. Do not flag ordinary progress. Flagging a stat does not guarantee a larger change; it only marks it as eligible. Only a critical that actually fires mechanically bypasses relationship inertia. Still provide your normal stat value for it.',
        '- proposedHardLocks: OPTIONAL. ONLY for characters marked "Hard-lock eligible: YES". If "NO", you MUST leave this empty for that character. When eligible, and if the character\'s defined personality/psychology/history makes a stat realistically incapable of exceeding a certain level (e.g. a deeply traumatized character who cannot trust past ~40%), propose a cap as {"stat":"category.stat","cap":NUMBER,"reason":"..."}. Propose ONLY when strongly justified \u2014 a hard lock is exceptional, reserved for a true defining ceiling, never routine. Most scenes should propose ZERO. Do not lock a stat just because it is plausible or currently low. When in doubt, leave it empty. Grounded in their stated personality — never guess on a blank slate. Leave empty for most characters. Do NOT propose caps below the stat\'s current value.',
        '- proposedSoftLocks: OPTIONAL, eligible characters only, and ONLY if the character\'s "Soft-lock slot" is OPEN. A character may have at most ONE active soft lock at a time, and a cooldown applies after one is set or resolved. If no slots are open, propose NONE. The "Soft-lock slots OPEN" number is a CEILING, not a target — propose anywhere from zero up to that many, and zero or one is the typical, expected answer. A soft lock caps a stat UNTIL {{user}} fulfills a specific narrative condition you define (e.g. romantic.affection capped at 45 until they share several genuine meals together); it is removed by meeting the condition, not by a critical. Each entry: {"stat":"category.stat","cap":NUMBER,"condition":"...","progress":"..."}. Never propose a lock just to use an available slot — only when it is genuinely warranted by the story.',
        '- unlockedSoftLocks: for any EXISTING soft lock listed in the character\'s data, if its condition was FULFILLED during this scene, list its "category.stat" here. The stat will then auto-unlock and resume normal growth. Only include locks that are genuinely satisfied by what happened.',
        '- softLockProgress: for existing soft locks that are NOT yet met, optionally provide an updated prose progress note reflecting movement toward the condition this scene.',
        '- hardLockPressureUpdates: ONLY for stats that ALREADY have a hard lock (shown with "pressure X/5"). NEVER create pressure for an unlocked stat. Pressure tracks EVIDENCE the character is acting against the lock\'s psychological REASON; it does NOT change the stat value. Scale: +2 major sustained contradiction; +1 meaningful contradiction; 0 no change (default for almost every scene); -1 reinforced the locked pattern; -2 severe regression. Changes must be RARE and evidence-based. Possessiveness, jealousy, attraction, fascination, sexual tension, protectiveness, or angst do NOT count unless the behavior directly contradicts the specific lock reason. COUNTS: relying on {{user}}\'s judgment without controlling the outcome (contradicts a belief that reliance is weakness). Does NOT count: becoming more fascinated (not structural), or protecting {{user}} because they consider {{user}} theirs (possessive protection reinforces the lock).',
        '- hardLockReviews: include an entry ONLY when a hard lock pressure reaches max (5/5) this scene. Shape {"stat":"category.stat","recommendation":"maintain|raise_cap|convert_to_soft|remove","recommendedCap":NUMBER,"reason":"..."}. Recommend a modest raise (+5/+10) unless evidence is overwhelming (+15 max). You only recommend; the user decides.',
        '- RELATIONSHIP INERTIA: trajectory/history are context, NOT a momentum bonus. Repeated positive scenes do not justify progressively larger positive changes. Established psychologically rigid characters may require qualitatively specific evidence to move entrenched stats; merely accumulating pleasant interactions is insufficient. Likewise, one ordinary awkward scene should not violently reverse a deeply established direction. Use criticalStats for genuinely pivotal evidence rather than softening or hardening a character through repetition alone.',
        '- Affection, fascination, jealousy, protectiveness, possessiveness, sexual interest, or obsession MUST NOT be used as shortcuts for trust/openness/support. A character can become more attached while remaining internally rigid.',
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
        const trajectory = deriveRelationshipTrajectory(char);
        parts.push(`  Relationship trajectory: ${trajectory.label} (${trajectory.explanation})`);
        const inertiaHistory = getRelationshipInertiaContext(char);
        if (inertiaHistory.length) {
            parts.push(`  Recent approved per-stat movement for inertia (newest first; descriptive only, never a bonus):`);
            for (const line of inertiaHistory) parts.push(`    ${line}`);
        }
        const recentMilestones = Array.isArray(char.relationshipMilestones) ? char.relationshipMilestones.slice(-3) : [];
        if (recentMilestones.length) {
            parts.push(`  Recent relationship milestones (historical anchors; do not repeat unless a NEW turning point occurs):`);
            for (const ms of recentMilestones) parts.push(`    - ${ms.title}: ${ms.description}`);
        }
        const activeConditions = Array.isArray(char.relationshipConditions) ? char.relationshipConditions : [];
        if (activeConditions.length) {
            parts.push(`  ACTIVE TEMPORARY RELATIONSHIP CONDITIONS:`);
            for (const condition of activeConditions) {
                const def = getRelationshipConditionDefinition(condition.type);
                if (!def) continue;
                parts.push(`    [${condition.id}] ${def.label}: ${def.meaning} Effect: ${def.effect} Current reason: ${condition.reason || ""} Resolves when: ${condition.resolution || ""}`);
            }
        }
        if (char.description && char.description.trim()) {
            parts.push(`  Personality/description: ${char.description}`);
            if (char.notes && char.notes.trim()) parts.push(`  Notes: ${char.notes}`);
            parts.push(`  Hard-lock eligible: YES (personality is defined).`);
        } else {
            parts.push(`  Hard-lock eligible: NO — personality is empty. Do NOT propose any hard locks for this character.`);
        }
        const visibleCategories = getVisibleStatCategories(char);
        parts.push(`  Visible/active stat categories for this character: ${visibleCategories.length ? visibleCategories.join(", ") : "NONE"}. Hidden categories are off-limits: do not see, update, lock, unlock, or comment on them.`);
        parts.push(`  Stats:`);
        for (const cat of visibleCategories) {
            const stats = char.stats[cat];
            parts.push(`    ${cat}: trust=${stats.trust}%, openness=${stats.openness}%, support=${stats.support}%, affection=${stats.affection}%`);
        }
        // Existing hard-lock caps, if any — with pressure state + cap history.
        const lockLines = [];
        if (char.hardLocks) {
            for (const cat of visibleCategories) {
                for (const stat of STAT_NAMES) {
                    const lk = char.hardLocks[cat]?.[stat];
                    if (lk && typeof lk.cap === 'number') {
                        let line = `    ${cat}.${stat} capped at ${lk.cap}%${lk.reason ? ` (${lk.reason})` : ''}`;
                        const p = lk.pressure;
                        if (p && typeof p.value === 'number') {
                            line += ` | pressure ${p.value}/${p.max || 5}`;
                            if (p.reason) line += ` (latest: ${p.reason})`;
                        }
                        if (p && Array.isArray(p.history) && p.history.length > 0) {
                            const hist = p.history.map(h => `cap ${h.fromCap}->${h.toCap}: ${h.reason || ''}`).join('; ');
                            line += ` | prior cap changes earned through pressure: ${hist}`;
                        }
                        lockLines.push(line);
                    }
                }
            }
        }
        if (lockLines.length > 0) {
            parts.push(`  Hard-lock caps (these stats cannot rise above the cap through ordinary growth). "pressure X/5" tracks evidence the character is acting AGAINST the lock's psychological reason:`);
            parts.push(...lockLines);
        }
        // Existing soft locks (conditional caps the LLM can mark as met)
        const softLines = [];
        if (char.softLocks) {
            for (const cat of visibleCategories) {
                for (const stat of STAT_NAMES) {
                    const sl = char.softLocks[cat]?.[stat];
                    if (sl && typeof sl.cap === 'number' && !sl.met) {
                        softLines.push(`    ${cat}.${stat} soft-capped at ${sl.cap}% UNTIL: ${sl.condition || '(unspecified)'}${sl.progress ? ` [progress so far: ${sl.progress}]` : ''}`);
                    }
                }
            }
        }
        if (softLines.length > 0) {
            parts.push(`  Soft locks (capped until a condition is met — mark in unlockedSoftLocks if fulfilled this scene):`);
            parts.push(...softLines);
        }
        // Soft-lock availability for NEW proposals (cap of 1 active + cooldown).
        try {
            const avail = getSoftLockAvailability(char, getClosedSceneCountForChar(char.id));
            if (avail.allowed) {
                parts.push(`  Soft-lock slots OPEN: ${avail.slotsFree} (a CEILING). You MAY propose up to ${avail.slotsFree} new soft lock(s) for this character ONLY if narratively fitting — zero is a perfectly normal and common answer. Do not fill slots just because they exist.`);
            } else {
                parts.push(`  Soft-lock slot: CLOSED (${avail.reason}) — do NOT propose a new soft lock for this character this scene. You may still update progress or mark an existing one met.`);
            }
        } catch (e) { /* non-fatal */ }
    }

    // Scene messages
    const _persona = getPersonaContext();
    const userName = _persona.name || getContext().name1 || "User";
    if (_persona.description) {
        parts.push(`\nABOUT ${userName} (the user/player): ${_persona.description}`);
    }
    parts.push(`\nSCENE MESSAGES ("${userName}" is the user/player, all other named speakers are characters). When writing soft-lock conditions, refer to the user as "${userName}":`);
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

function isVisibleStatKeyForProfile(profile, statKey) {
    if (typeof statKey !== "string") return false;
    const [cat, stat] = statKey.toLowerCase().trim().split(".");
    return STAT_CATEGORIES.includes(cat) && STAT_NAMES.includes(stat) && isStatCategoryVisible(profile, cat);
}

function filterStatKeyArrayForProfile(profile, arr) {
    if (!Array.isArray(arr)) return [];
    return arr
        .map((x) => String(x || "").toLowerCase().trim())
        .filter((x) => isVisibleStatKeyForProfile(profile, x));
}

function filterStatObjectByVisibleCategories(profile, obj) {
    const filtered = {};
    if (!obj || typeof obj !== "object") return filtered;
    for (const cat of getVisibleStatCategories(profile)) {
        if (obj[cat] && typeof obj[cat] === "object") {
            filtered[cat] = obj[cat];
        }
    }
    return filtered;
}

function filterStatEntryArrayForProfile(profile, arr) {
    if (!Array.isArray(arr)) return [];
    return arr.filter((entry) => entry && isVisibleStatKeyForProfile(profile, entry.stat));
}

function normalizeProposedMilestones(profile, arr) {
    if (!Array.isArray(arr)) return [];
    const visible = new Set(getVisibleStatCategories(profile));
    const result = [];
    for (const raw of arr) {
        if (!raw || typeof raw !== "object") continue;
        const title = String(raw.title || "").trim().slice(0, 120);
        const description = String(raw.description || "").trim().slice(0, 1200);
        if (!title || !description) continue;
        const domains = [...new Set((Array.isArray(raw.domains) ? raw.domains : [])
            .map((x) => String(x || "").toLowerCase().trim())
            .filter((x) => visible.has(x)))];
        result.push({ title, description, domains });
        if (result.length >= 1) break;
    }
    return result;
}

function normalizeProposedConditions(profile, arr) {
    if (!Array.isArray(arr)) return [];
    const activeTypes = new Set((profile.relationshipConditions || []).map((c) => c?.type).filter(Boolean));
    const result = [];
    for (const raw of arr) {
        if (!raw || typeof raw !== "object") continue;
        const type = String(raw.type || "").trim();
        if (!getRelationshipConditionDefinition(type) || activeTypes.has(type)) continue;
        const reason = String(raw.reason || "").trim().slice(0, 1200);
        const resolution = String(raw.resolution || "").trim().slice(0, 1200);
        if (!reason || !resolution) continue;
        result.push({ type, reason, resolution });
        if (result.length >= MAX_NEW_CONDITIONS_PER_UPDATE) break;
    }
    return result;
}

function normalizeResolvedConditions(profile, arr) {
    if (!Array.isArray(arr)) return [];
    const activeIds = new Set((profile.relationshipConditions || []).map((c) => c?.id).filter(Boolean));
    const result = [];
    for (const raw of arr) {
        if (!raw || typeof raw !== "object") continue;
        const id = String(raw.id || "").trim();
        if (!activeIds.has(id)) continue;
        result.push({
            id,
            reason: String(raw.reason || "").trim().slice(0, 1200),
        });
    }
    return result;
}

function filterCharacterDataByVisibleCategories(profile, data) {
    if (!data || typeof data !== "object") return data;
    const clone = { ...data };
    delete clone.evidenceRefs;
    clone.stats = filterStatObjectByVisibleCategories(profile, data.stats);
    clone.commentary = filterStatObjectByVisibleCategories(profile, data.commentary);
    clone.proposedMilestones = Array.isArray(data.proposedMilestones) ? data.proposedMilestones : [];
    clone.proposedConditions = Array.isArray(data.proposedConditions) ? data.proposedConditions : [];
    clone.resolvedConditions = Array.isArray(data.resolvedConditions) ? data.resolvedConditions : [];
    clone.criticalStats = filterStatKeyArrayForProfile(profile, data.criticalStats);
    clone.proposedHardLocks = filterStatEntryArrayForProfile(profile, data.proposedHardLocks);
    clone.proposedSoftLocks = filterStatEntryArrayForProfile(profile, data.proposedSoftLocks);
    clone.unlockedSoftLocks = filterStatKeyArrayForProfile(profile, data.unlockedSoftLocks);
    clone.softLockProgress = filterStatEntryArrayForProfile(profile, data.softLockProgress);
    clone.hardLockPressureUpdates = filterStatEntryArrayForProfile(profile, data.hardLockPressureUpdates);
    clone.hardLockReviews = filterStatEntryArrayForProfile(profile, data.hardLockReviews);
    return clone;
}


function normalizeCharacterName(name) {
    return String(name || "").toLowerCase().trim();
}

function findParsedCharacterEntryForProfile(parsedCharacters, profile, consumedKeys = null) {
    if (!parsedCharacters || !profile) return null;
    const keys = Object.keys(parsedCharacters);
    const variants = new Set(getCharacterNameVariants(profile).map(normalizeCharacterName));

    // Prefer exact/canonical/alias matches first. Compare normalized strings so
    // an LLM key like "Mira" still matches an alias saved as "mira".
    for (const key of keys) {
        if (consumedKeys?.has(key)) continue;
        if (variants.has(normalizeCharacterName(key))) {
            return { key, data: parsedCharacters[key] };
        }
    }

    // Fuzzy fallback catches reversed names and common shortened forms.
    for (const key of keys) {
        if (consumedKeys?.has(key)) continue;
        const matched = findCharacterByFuzzyName(key);
        if (matched && matched.id === profile.id) {
            return { key, data: parsedCharacters[key] };
        }
    }

    return null;
}

function buildStatsFromInitialData(charData) {
    const statsAfter = {};
    for (const cat of STAT_CATEGORIES) {
        statsAfter[cat] = {};
        for (const stat of STAT_NAMES) {
            const val = charData?.stats?.[cat]?.[stat];
            statsAfter[cat][stat] = typeof val === "number" && !isNaN(val)
                ? Math.max(-100, Math.min(100, val))
                : 0;
        }
    }
    return statsAfter;
}

function buildInitialCommentary(charData, statsAfter, char = null) {
    let commentary = charData?.commentary || null;
    if (!commentary || hasEmptyCommentary(commentary)) {
        commentary = {};
        for (const cat of STAT_CATEGORIES) {
            commentary[cat] = {};
            for (const stat of STAT_NAMES) {
                const val = statsAfter?.[cat]?.[stat] ?? 0;
                if (val > 0) {
                    commentary[cat][stat] = "First impressions suggest positive feelings.";
                } else if (val < 0) {
                    commentary[cat][stat] = "First impressions suggest negative feelings.";
                } else {
                    commentary[cat][stat] = "No strong initial impression formed.";
                }
            }
        }
    } else {
        commentary = fillMissingCommentary(commentary, char ? cloneStats(char.stats) : {}, statsAfter, char || undefined);
    }
    return commentary;
}

function createInitialUpdateEntry(char, charData, source = "llm_initial", messageCount = Infinity) {
    const filteredData = filterCharacterDataByVisibleCategories(char, charData || {});
    const statsAfter = buildStatsFromInitialData(filteredData);
    const commentary = buildInitialCommentary(filteredData, statsAfter, char);
    return {
        characterId: char.id,
        characterName: char.name,
        statsBefore: cloneStats(char.stats),
        statsAfter,
        commentary,
        proposedMilestones: normalizeProposedMilestones(char, filteredData.proposedMilestones),
        proposedConditions: normalizeProposedConditions(char, filteredData.proposedConditions),
        resolvedConditions: [],
        dynamicTitleBefore: char.dynamicTitle || "",
        dynamicTitleAfter: filteredData.dynamicTitle || char.dynamicTitle || "",
        milestoneReached: false,
        milestoneDetail: "",
        narrativeSummary: filteredData.narrativeSummary || char.narrativeSummary || "",
        criticalStats: Array.isArray(filteredData.criticalStats) ? filteredData.criticalStats : [],
        inertiaAdjustments: [],
        raisedCaps: [],
        proposedHardLocks: Array.isArray(filteredData.proposedHardLocks) ? filteredData.proposedHardLocks : [],
        proposedSoftLocks: Array.isArray(filteredData.proposedSoftLocks) ? filteredData.proposedSoftLocks : [],
        unlockedSoftLocks: Array.isArray(filteredData.unlockedSoftLocks) ? filteredData.unlockedSoftLocks : [],
        softLockProgress: Array.isArray(filteredData.softLockProgress) ? filteredData.softLockProgress : [],
        hardLockPressureUpdates: Array.isArray(filteredData.hardLockPressureUpdates) ? filteredData.hardLockPressureUpdates : [],
        hardLockReviews: Array.isArray(filteredData.hardLockReviews) ? filteredData.hardLockReviews : [],
        source,
        changeCount: countChanges(cloneStats(char.stats), statsAfter),
    };
}

function characterUpdateScore(update) {
    if (!update) return -1;
    let score = 0;
    const changeCount = Number(update.changeCount || 0);
    if (changeCount > 0) score += 1000 + changeCount;
    if (String(update.source || "").includes("initial")) score += 100;
    if (update.statsAfter && typeof update.statsAfter === "object") score += 50;
    if (update.commentary && !hasEmptyCommentary(update.commentary)) score += 25;
    if (update.dynamicTitleAfter) score += 10;
    if (update.narrativeSummary) score += 10;
    if (Array.isArray(update.proposedHardLocks) && update.proposedHardLocks.length) score += 5;
    if (Array.isArray(update.proposedSoftLocks) && update.proposedSoftLocks.length) score += 5;
    if (Array.isArray(update.proposedMilestones) && update.proposedMilestones.length) score += 4;
    if (Array.isArray(update.proposedConditions) && update.proposedConditions.length) score += 4;
    if (Array.isArray(update.resolvedConditions) && update.resolvedConditions.length) score += 4;
    return score;
}

function dedupeCharacterUpdates(characterUpdates) {
    if (!Array.isArray(characterUpdates) || characterUpdates.length < 2) return characterUpdates || [];
    const byId = new Map();
    const order = [];
    for (const update of characterUpdates) {
        if (!update || !update.characterId) continue;
        const prev = byId.get(update.characterId);
        if (!prev) {
            byId.set(update.characterId, update);
            order.push(update.characterId);
            continue;
        }
        const chosen = characterUpdateScore(update) > characterUpdateScore(prev) ? update : prev;
        byId.set(update.characterId, chosen);
        dlog(`[RST] Deduped duplicate pending stat update for ${chosen.characterName || chosen.characterId}.`);
    }
    return order.map((id) => byId.get(id)).filter(Boolean);
}

// ─── Response Parsing ─────────────────────────────────────

/**
 * Parse the LLM response into structured update data.
 * @param {string} response - Raw LLM output
 * @param {Array} characters - Character profiles
 * @returns {{sceneSummary: string, characterUpdates: Array}}
 */
function parseStatUpdateResponse(response, characters, messageCount = Infinity) {
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
    const consumedCharacterKeys = new Set();

    for (const char of characters) {
        // Try exact canonical name, aliases, then fuzzy match. Track the consumed
        // LLM key so a canonical+alias pair cannot become two pending cards.
        const charEntry = findParsedCharacterEntryForProfile(parsed.characters, char, consumedCharacterKeys);
        let charData = charEntry?.data;
        if (charEntry?.key) consumedCharacterKeys.add(charEntry.key);
        if (!charData) {
            // Character not found in LLM response — create a no-change entry
            characterUpdates.push(createNoChangeEntry(char));
            continue;
        }
        charData = filterCharacterDataByVisibleCategories(char, charData);

        const statsBefore = cloneStats(char.stats);
        const settings = getSettings();
        const range = settings.statChangeRange || { min: -5, max: 5 };
        // Merge LLM stats over existing stats so unmentioned ones don't default to 0
        const mergedStats = mergeWithExistingStats(statsBefore, charData.stats || {});
        const trajectory = deriveRelationshipTrajectory(char);
        const firedCriticals = resolveFiredCriticalStats(charData.criticalStats, settings);
        const inertiaResult = applyRelationshipInertia(char, statsBefore, clampStats(mergedStats), firedCriticals, trajectory.label, range);
        const statsAfter = applyDeltaRange(statsBefore, inertiaResult.statsAfter, range, charData.criticalStats, settings, char.hardLocks, char.softLocks, charData.unlockedSoftLocks, firedCriticals);
        const raisedCaps = statsAfter.__raisedCaps || [];
        const unlockedSoftLocks = statsAfter.__unlockedSoftLocks || [];
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
            proposedMilestones: normalizeProposedMilestones(char, charData.proposedMilestones),
            proposedConditions: normalizeProposedConditions(char, charData.proposedConditions),
            resolvedConditions: normalizeResolvedConditions(char, charData.resolvedConditions),
            dynamicTitleBefore: char.dynamicTitle || "",
            dynamicTitleAfter: charData.dynamicTitle || char.dynamicTitle || "",
            milestoneReached: charData.milestoneReached || false,
            milestoneDetail: charData.milestoneDetail || "",
            narrativeSummary: charData.narrativeSummary || char.narrativeSummary || "",
            criticalStats: firedCriticals,
            inertiaAdjustments: inertiaResult.adjustments,
            raisedCaps,
            proposedHardLocks: Array.isArray(charData.proposedHardLocks) ? charData.proposedHardLocks : [],
            proposedSoftLocks: Array.isArray(charData.proposedSoftLocks) ? charData.proposedSoftLocks : [],
            unlockedSoftLocks,
            softLockProgress: Array.isArray(charData.softLockProgress) ? charData.softLockProgress : [],
            hardLockPressureUpdates: Array.isArray(charData.hardLockPressureUpdates) ? charData.hardLockPressureUpdates : [],
            hardLockReviews: Array.isArray(charData.hardLockReviews) ? charData.hardLockReviews : [],
            source: "llm",
            changeCount,
        });
    }

    // Handle LLM-discovered characters (in parsed.characters but not in input list)
    if (parsed && parsed.characters) {
        const inputNameVariants = new Set(characters.flatMap(c => getCharacterNameVariants(c)).map(normalizeCharacterName));
        const allKnownChars = getAllCharacters();
        for (const [llmName, rawLlmData] of Object.entries(parsed.characters)) {
            let llmData = rawLlmData;
            const lowerLlmName = normalizeCharacterName(llmName);
            if (!consumedCharacterKeys.has(llmName) && !inputNameVariants.has(lowerLlmName) && llmData && llmData.stats) {
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
                    if (characterUpdates.some((u) => u.characterId === matchedExisting.id)) {
                        dlog(`[RST] Skipping duplicate LLM-discovered key "${llmName}" for existing character "${matchedExisting.name}".`);
                        continue;
                    }
                    // Name matches existing character — create update entry instead of duplicate
                    dlog(`[RST] LLM name "${llmName}" matches existing character "${matchedExisting.name}" — creating update entry`);
                    llmData = filterCharacterDataByVisibleCategories(matchedExisting, llmData);
                    const statsBefore = cloneStats(matchedExisting.stats);
                    const settings = getSettings();
                    const range = settings.statChangeRange || { min: -5, max: 5 };
                    // Merge LLM stats over existing stats so unmentioned ones don't default to 0
                    const mergedStats = mergeWithExistingStats(statsBefore, llmData.stats || {});
                    const trajectory = deriveRelationshipTrajectory(matchedExisting);
                    const firedCriticals = resolveFiredCriticalStats(llmData.criticalStats, settings);
                    const inertiaResult = applyRelationshipInertia(matchedExisting, statsBefore, clampStats(mergedStats), firedCriticals, trajectory.label, range);
                    const statsAfter = applyDeltaRange(statsBefore, inertiaResult.statsAfter, range, llmData.criticalStats, settings, matchedExisting.hardLocks, matchedExisting.softLocks, llmData.unlockedSoftLocks, firedCriticals);
                    const raisedCaps = statsAfter.__raisedCaps || [];
                    const unlockedSoftLocks = statsAfter.__unlockedSoftLocks || [];
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
                        criticalStats: firedCriticals,
                        inertiaAdjustments: inertiaResult.adjustments,
                        raisedCaps,
                        proposedHardLocks: Array.isArray(llmData.proposedHardLocks) ? llmData.proposedHardLocks : [],
                        proposedSoftLocks: Array.isArray(llmData.proposedSoftLocks) ? llmData.proposedSoftLocks : [],
                        unlockedSoftLocks,
                        softLockProgress: Array.isArray(llmData.softLockProgress) ? llmData.softLockProgress : [],
                        hardLockPressureUpdates: Array.isArray(llmData.hardLockPressureUpdates) ? llmData.hardLockPressureUpdates : [],
                        hardLockReviews: Array.isArray(llmData.hardLockReviews) ? llmData.hardLockReviews : [],
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

    return { sceneSummary, sceneTitle, characterUpdates: dedupeCharacterUpdates(characterUpdates) };
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
        const fallbackTrajectory = deriveRelationshipTrajectory(char);
        const fallbackInertia = applyRelationshipInertia(char, statsBefore, clampStats(mergedStats), [], fallbackTrajectory.label, range);
        const clampedAfter = applyDeltaRange(statsBefore, fallbackInertia.statsAfter, range);
        // Preserve old commentary for unchanged stats via fillMissingCommentary
        const filledCommentary = fillMissingCommentary(commentary, statsBefore, clampedAfter, char);

        characterUpdates.push({
            characterId: char.id,
            characterName: char.name,
            statsBefore,
            statsAfter: clampedAfter,
            commentary: filledCommentary,
            proposedMilestones: [],
            proposedConditions: [],
            resolvedConditions: [],
            inertiaAdjustments: fallbackInertia.adjustments,
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

    // Build exclusion logic: persona name + settings blacklist.
    const personaName = getContext().name1 || "";
    function isExcluded(name) {
        return isNameBlacklisted(name, ["{{user}}", "user", personaName]);
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
            // Use alias-aware fuzzy matching so "Jane" matches "Jane Doe"
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
 * Resolve which LLM-flagged critical candidates actually fire. RNG is resolved
 * before inertia so a candidate that loses its roll receives ordinary inertia.
 */
function resolveFiredCriticalStats(criticalStats = null, settings = null) {
    const crit = settings?.criticalChanges || {};
    if (crit.enabled === false || !Array.isArray(criticalStats) || criticalStats.length === 0) return [];

    const chance = typeof crit.chance === "number" ? Math.max(0, Math.min(100, crit.chance)) : 7;
    const fired = [];
    const seen = new Set();
    for (const entry of criticalStats) {
        if (typeof entry !== "string") continue;
        const key = entry.toLowerCase().trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        if ((Math.random() * 100) < chance) fired.push(key);
    }
    return fired;
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
function applyDeltaRange(statsBefore, statsAfter, range, criticalStats = null, settings = null, hardLocks = null, softLocks = null, metSoftLocks = null, preResolvedCriticalStats = null) {
    // Resolve critical-change config. A stat goes critical only if (a) the feature
    // is enabled, (b) the LLM flagged it in criticalStats, AND (c) it wins an RNG
    // roll against the configured chance. Winners get a multiplier x wider ceiling.
    const crit = settings?.criticalChanges || {};
    const critEnabled = crit.enabled !== false && Array.isArray(criticalStats) && criticalStats.length > 0;
    const critChance = typeof crit.chance === 'number' ? crit.chance : 7;
    const critMult = typeof crit.multiplier === 'number' ? crit.multiplier : 3;

    // Hard locks config. When enabled, a per-stat cap blocks NORMAL growth above
    // the cap. A CRITICAL change is the only thing that can push past a cap, and
    // doing so RAISES the cap to the new value (so a further critical is needed to
    // climb again). Locks are respected only when the feature is on.
    const locksOn = (settings?.hardLocks?.enabled !== false);
    // Soft locks: per-stat cap that gates growth UNTIL an LLM-defined condition
    // is met, then the stat auto-unlocks. A critical does NOT break a soft lock.
    const softOn = (settings?.softLocks?.enabled !== false);
    const metSet = new Set(Array.isArray(metSoftLocks) ? metSoftLocks.map(s => String(s).toLowerCase().trim()) : []);

    // Normalize the flagged set to a quick lookup of "category.stat".
    const flagged = new Set();
    if (critEnabled) {
        for (const entry of criticalStats) {
            if (typeof entry === 'string') flagged.add(entry.toLowerCase().trim());
        }
    }

    // Track which stats actually went critical, and which caps got raised. If
    // preResolvedCriticalStats is supplied, RNG already ran before inertia.
    const preResolved = Array.isArray(preResolvedCriticalStats);
    const preResolvedSet = new Set(preResolved ? preResolvedCriticalStats.map((x) => String(x || "").toLowerCase().trim()) : []);
    const firedCriticals = [];
    const raisedCaps = []; // [{ stat: 'cat.stat', from: number, to: number }]
    const unlockedSoftLocks = []; // ['cat.stat', ...] conditions met this scene

    const result = {};
    for (const cat of STAT_CATEGORIES) {
        result[cat] = {};
        for (const stat of STAT_NAMES) {
            const before = statsBefore[cat]?.[stat] ?? 0;
            const after = statsAfter[cat]?.[stat] ?? 0;

            let loMul = range.min;
            let hiMul = range.max;

            // Critical gate: use the already-resolved winner set on the normal
            // relationship path, otherwise retain legacy inline RNG for callers
            // that do not use inertia. A flagged-but-lost candidate stays ordinary.
            let isCrit = false;
            const statKey = cat + '.' + stat;
            if (critEnabled && flagged.has(statKey)) {
                const fired = preResolved
                    ? preResolvedSet.has(statKey)
                    : ((Math.random() * 100) < critChance);
                if (fired) {
                    loMul = range.min * critMult;
                    hiMul = range.max * critMult;
                    firedCriticals.push(statKey);
                    isCrit = true;
                }
            }

            const minVal = before + loMul;
            const maxVal = before + hiMul;
            // Range-clamped proposed value (pre-lock).
            let value = Math.max(-100, Math.min(100, Math.max(minVal, Math.min(maxVal, after))));

            // ── Hard-lock enforcement ──
            const lock = locksOn ? hardLocks?.[cat]?.[stat] : null;
            const cap = (lock && typeof lock.cap === 'number') ? lock.cap : null;
            if (cap !== null) {
                if (value > cap) {
                    if (isCrit) {
                        // A critical breaks through: the value is allowed past the
                        // cap, and the cap RISES to meet the new value.
                        raisedCaps.push({ stat: cat + '.' + stat, from: cap, to: value });
                    } else {
                        // Normal growth cannot cross the cap.
                        value = cap;
                    }
                }
            }

            // ── Soft-lock enforcement ──
            const slock = softOn ? softLocks?.[cat]?.[stat] : null;
            const scap = (slock && typeof slock.cap === 'number') ? slock.cap : null;
            if (scap !== null && !slock.met) {
                const conditionMet = metSet.has(cat + '.' + stat);
                if (conditionMet) {
                    // Condition fulfilled this scene -> auto-unlock; growth is free.
                    unlockedSoftLocks.push(cat + '.' + stat);
                } else if (value > scap) {
                    // Still locked: gate growth at the soft cap. Criticals do NOT
                    // break soft locks — only the condition does.
                    value = scap;
                }
            }

            result[cat][stat] = value;
        }
    }
    // Stash side outputs on the result object (non-enumerable so they don't
    // pollute the stat shape when iterated/serialized as plain stats).
    Object.defineProperty(result, '__criticals', { value: firedCriticals, enumerable: false });
    Object.defineProperty(result, '__raisedCaps', { value: raisedCaps, enumerable: false });
    Object.defineProperty(result, '__unlockedSoftLocks', { value: unlockedSoftLocks, enumerable: false });
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

    const result = await makeRequest(profileName, systemPrompt, requestPrompt, 20000, 0.3);
    if (!result) {
        return { sceneSummary: "", characterUpdates: [] };
    }

    return parseInitialStatResponse(result, characters, messages.length);
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
        '        "proposedMilestones": [{"title":"...","description":"...","domains":["platonic"]}],',
        '        "proposedConditions": [{"type":"guarded","reason":"why it is active now","resolution":"what would resolve it"}],',
        '        "dynamicTitle": "...",',
        '        "narrativeSummary": "...",',
        '        "criticalStats": ["category.stat for any stat where a narratively pivotal moment justifies an unusually large shift"],',
        '        "proposedHardLocks": [{"stat":"category.stat","cap":NUMBER,"reason":"why this character\'s psychology caps this stat here"}],',
        '        "proposedSoftLocks": [{"stat":"category.stat","cap":NUMBER,"condition":"what {{user}} must do to unlock further growth","progress":"current prose progress toward it"}],',
        '        "unlockedSoftLocks": ["category.stat for any EXISTING soft lock whose condition was fulfilled this scene"],',
        '        "softLockProgress": [{"stat":"category.stat","progress":"updated prose progress note for an existing, still-locked soft lock"}]',
        '      }',
        '    }',
        '  }',
        '',
        'Rules:',
        '- Stats represent character\'s feelings toward {{user}}, not reverse.',
        '- Per-character category visibility is authoritative. If a character is shown with only some visible/active categories, ONLY output stats/commentary/criticalStats/locks/pressure/reviews for those visible categories. Do not infer, update, propose locks for, unlock, or mention hidden categories.',
        '- A character can be affected by a scene WITHOUT face-to-face interaction. If a character observes, surveils, directs, or remotely influences events involving {{user}} (even unknown to {{user}}), their feelings can still shift. Base their stat changes on what they witness, learn, or do from afar — e.g. watching {{user}} can deepen fixation (affection), build a sense of knowing them (openness), or erode/strengthen trust based on what is observed.',
        '- Asymmetric awareness is valid: only update a character based on what THAT character is aware of. If {{user}} does not know a character is involved, {{user}}-facing dynamics may be one-sided, and that is correct.',
        '- proposedMilestones: OPTIONAL and RARE. RST milestones are ONLY about THIS CHARACTER <-> {{user}}; never use an NPC<->NPC event. Require a durable, consequential relationship redefinition, not a thank-you, food/comfort gesture, ordinary encouragement, first meeting, routine apology, generic fight, or single vulnerable line. At most 1 per character, with factual title/description and relevant domains.',
        `- proposedConditions: OPTIONAL. At most ${MAX_NEW_CONDITIONS_PER_UPDATE} new temporary relationship condition. Allowed types: ${getRelationshipConditionCatalogForPrompt()}. Give why it is active and a specific resolution condition. Conditions are contextual lenses, not permanent personality traits or stat bonuses.`,
        '- criticalStats: list "category.stat" entries (e.g. "romantic.affection") ONLY for stats where a genuinely PIVOTAL, story-defining moment occurred this scene that would justify a much larger-than-usual shift — a confession, betrayal, rescue, profound vulnerability, or similar turning point. Be sparing: most scenes have ZERO critical stats. Do not flag ordinary progress. Flagging a stat does not guarantee a larger change; it only marks it as eligible. Only a critical that actually fires mechanically bypasses relationship inertia. Still provide your normal stat value for it.',
        '- proposedHardLocks: OPTIONAL. ONLY for characters marked "Hard-lock eligible: YES". If "NO", you MUST leave this empty for that character. When eligible, and if the character\'s defined personality/psychology/history makes a stat realistically incapable of exceeding a certain level (e.g. a deeply traumatized character who cannot trust past ~40%), propose a cap as {"stat":"category.stat","cap":NUMBER,"reason":"..."}. Propose ONLY when strongly justified \u2014 a hard lock is exceptional, reserved for a true defining ceiling, never routine. Most scenes should propose ZERO. Do not lock a stat just because it is plausible or currently low. When in doubt, leave it empty. Grounded in their stated personality — never guess on a blank slate. Leave empty for most characters. Do NOT propose caps below the stat\'s current value.',
        '- proposedSoftLocks: OPTIONAL, eligible characters only, and ONLY if the character\'s "Soft-lock slot" is OPEN. A character may have at most ONE active soft lock at a time, and a cooldown applies after one is set or resolved. If no slots are open, propose NONE. The "Soft-lock slots OPEN" number is a CEILING, not a target — propose anywhere from zero up to that many, and zero or one is the typical, expected answer. A soft lock caps a stat UNTIL {{user}} fulfills a specific narrative condition you define (e.g. romantic.affection capped at 45 until they share several genuine meals together); it is removed by meeting the condition, not by a critical. Each entry: {"stat":"category.stat","cap":NUMBER,"condition":"...","progress":"..."}. Never propose a lock just to use an available slot — only when it is genuinely warranted by the story.',
        '- unlockedSoftLocks: for any EXISTING soft lock listed in the character\'s data, if its condition was FULFILLED during this scene, list its "category.stat" here. The stat will then auto-unlock and resume normal growth. Only include locks that are genuinely satisfied by what happened.',
        '- softLockProgress: for existing soft locks that are NOT yet met, optionally provide an updated prose progress note reflecting movement toward the condition this scene.',
        '- hardLockPressureUpdates: ONLY for stats that ALREADY have a hard lock (shown with "pressure X/5"). NEVER create pressure for an unlocked stat. Pressure tracks EVIDENCE the character is acting against the lock\'s psychological REASON; it does NOT change the stat value. Scale: +2 major sustained contradiction; +1 meaningful contradiction; 0 no change (default for almost every scene); -1 reinforced the locked pattern; -2 severe regression. Changes must be RARE and evidence-based. Possessiveness, jealousy, attraction, fascination, sexual tension, protectiveness, or angst do NOT count unless the behavior directly contradicts the specific lock reason. COUNTS: relying on {{user}}\'s judgment without controlling the outcome (contradicts a belief that reliance is weakness). Does NOT count: becoming more fascinated (not structural), or protecting {{user}} because they consider {{user}} theirs (possessive protection reinforces the lock).',
        '- hardLockReviews: include an entry ONLY when a hard lock pressure reaches max (5/5) this scene. Shape {"stat":"category.stat","recommendation":"maintain|raise_cap|convert_to_soft|remove","recommendedCap":NUMBER,"reason":"..."}. Recommend a modest raise (+5/+10) unless evidence is overwhelming (+15 max). You only recommend; the user decides.',
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
        const visibleCategories = getVisibleStatCategories(char);
        parts.push("    Visible/active stat categories: " + (visibleCategories.length ? visibleCategories.join(", ") : "NONE") + ". Hidden categories are off-limits.");
        // Personality gating for locks — same rule as the main update path. A
        // freshly-detected character usually has an empty Personality, so locks
        // must NOT be proposed until the user fills it in.
        if (char.description && char.description.trim()) {
            parts.push("    Personality: " + char.description);
            if (char.notes && char.notes.trim()) parts.push("    Notes: " + char.notes);
            parts.push("    Lock-eligible: YES (personality is defined).");
        } else {
            parts.push("    Lock-eligible: NO — personality is empty. Do NOT propose any hard or soft locks for this character.");
        }
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
    parts.push('- Example of INCLUDE: a character says "I talked with [Name]" or "[Name] handed me the package" — [Name] is interacting. ALSO INCLUDE remote involvement: "[Name] watched the feed of her" or "[Name]\'s operatives tailed her on his orders" — [Name] is shaping/observing the scene from afar and IS affected by it.');
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
function parseInitialStatResponse(response, characters, messageCount = Infinity) {
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
    const consumedCharacterKeys = new Set();

    for (const char of characters) {
        // Initial generation must resolve aliases/fuzzy names into the existing
        // zero-stat profile, not create a second "discovered" block for it.
        const charEntry = findParsedCharacterEntryForProfile(parsed.characters, char, consumedCharacterKeys);
        const charData = charEntry?.data;
        if (charEntry?.key) consumedCharacterKeys.add(charEntry.key);
        if (!charData || !charData.stats) {
            // Character not in response — create a no-change entry at zero
            characterUpdates.push(createNoChangeEntry(char));
            continue;
        }

        characterUpdates.push(createInitialUpdateEntry(char, charData, "llm_initial", messageCount));
    }

    // Handle LLM-discovered characters (in parsed.characters but not in input list)
    if (parsed && parsed.characters) {
        const inputNameVariants = new Set(characters.flatMap(c => getCharacterNameVariants(c)).map(normalizeCharacterName));
        const allKnownChars = getAllCharacters();
        for (const [llmName, llmData] of Object.entries(parsed.characters)) {
            const lowerLlmName = normalizeCharacterName(llmName);
            if (!consumedCharacterKeys.has(llmName) && !inputNameVariants.has(lowerLlmName) && llmData && llmData.stats) {
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
                    if (characterUpdates.some((u) => u.characterId === matchedExisting.id)) {
                        dlog(`[RST] Skipping duplicate initial LLM key "${llmName}" for existing character "${matchedExisting.name}".`);
                        continue;
                    }
                    // Name matches existing character — create one initial stat entry
                    // against that existing profile. If the profile is still all-zero,
                    // do NOT clamp by statChangeRange; this is first-time initialization.
                    dlog(`[RST] LLM name "${llmName}" matches existing character "${matchedExisting.name}" — creating initial stat update entry`);
                    if (isNewCharacter(matchedExisting)) {
                        characterUpdates.push(createInitialUpdateEntry(matchedExisting, llmData, "llm_initial", messageCount));
                    } else {
                        const filteredData = filterCharacterDataByVisibleCategories(matchedExisting, llmData);
                        const statsBefore = cloneStats(matchedExisting.stats);
                        const settings = getSettings();
                        const range = settings.statChangeRange || { min: -5, max: 5 };
                        const mergedStats = mergeWithExistingStats(statsBefore, filteredData.stats || {});
                        const matchedTrajectory = deriveRelationshipTrajectory(matchedExisting);
                        const firedCriticals = resolveFiredCriticalStats(filteredData.criticalStats, settings);
                        const matchedInertia = applyRelationshipInertia(matchedExisting, statsBefore, clampStats(mergedStats), firedCriticals, matchedTrajectory.label, range);
                        const clampedAfter = applyDeltaRange(statsBefore, matchedInertia.statsAfter, range, filteredData.criticalStats, settings, matchedExisting.hardLocks, matchedExisting.softLocks, filteredData.unlockedSoftLocks, firedCriticals);
                        const raisedCaps = clampedAfter.__raisedCaps || [];
                        const unlockedSoftLocks = clampedAfter.__unlockedSoftLocks || [];
                        let commentary = filteredData.commentary || null;
                        if (!commentary || hasEmptyCommentary(commentary)) {
                            commentary = generateFallbackCommentary(statsBefore, clampedAfter, matchedExisting);
                        } else {
                            commentary = fillMissingCommentary(commentary, statsBefore, clampedAfter, matchedExisting);
                        }
                        characterUpdates.push({
                            characterId: matchedExisting.id,
                            characterName: matchedExisting.name,
                            statsBefore,
                            statsAfter: clampedAfter,
                            commentary,
                                            proposedMilestones: [],
                            proposedConditions: [],
                            resolvedConditions: [],
                            dynamicTitleBefore: matchedExisting.dynamicTitle || "",
                            dynamicTitleAfter: filteredData.dynamicTitle || matchedExisting.dynamicTitle || "",
                            milestoneReached: false,
                            milestoneDetail: "",
                            narrativeSummary: filteredData.narrativeSummary || matchedExisting.narrativeSummary || "",
                            criticalStats: firedCriticals,
                            inertiaAdjustments: matchedInertia.adjustments,
                            raisedCaps,
                            proposedHardLocks: Array.isArray(filteredData.proposedHardLocks) ? filteredData.proposedHardLocks : [],
                            proposedSoftLocks: Array.isArray(filteredData.proposedSoftLocks) ? filteredData.proposedSoftLocks : [],
                            unlockedSoftLocks,
                            softLockProgress: Array.isArray(filteredData.softLockProgress) ? filteredData.softLockProgress : [],
                            hardLockPressureUpdates: Array.isArray(filteredData.hardLockPressureUpdates) ? filteredData.hardLockPressureUpdates : [],
                            hardLockReviews: Array.isArray(filteredData.hardLockReviews) ? filteredData.hardLockReviews : [],
                            source: "llm",
                            changeCount: countChanges(statsBefore, clampedAfter),
                        });
                    }
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

    return { sceneSummary, sceneTitle, characterUpdates: dedupeCharacterUpdates(characterUpdates) };
}
