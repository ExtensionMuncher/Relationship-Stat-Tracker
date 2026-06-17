/**
 * llm/lockScan.js — "Scan for Locks" (debug/maintenance feature)
 *
 * Reads each character's Personality (description) + Notes, plus existing scene
 * summaries for context, and asks the stat-update LLM to propose hard-lock caps
 * grounded in that character's established psychology.
 *
 * STRICT RULE: characters whose Personality (description) is empty are SKIPPED
 * entirely — the model is never asked to guess locks on a blank slate. This
 * saves tokens and avoids freestyled, ungrounded caps.
 *
 * Proposed locks are returned to the caller for user review/confirmation before
 * anything is written — this never silently mutates profiles.
 */

import { getSettings } from "../data/storage.js";
import { getAllCharacters, STAT_CATEGORIES, STAT_NAMES } from "../data/characters.js";
import { getAllSceneSummaries } from "../data/scenes.js";
import { makeRequest } from "./connections.js";
import { dlog } from "../lib/debug.js";

/**
 * Run a lock scan across the library.
 * @returns {Promise<Array<{characterId, characterName, hardLocks: Array, softLocks: Array}>>}
 *          Proposed locks per character. Characters with no personality, or no
 *          proposals, are omitted.
 */
export async function scanForLocks() {
    const settings = getSettings();
    const profileName = settings.connections?.statUpdateLLM;
    if (!profileName) {
        toastr?.error?.("No Stat Update LLM connection profile is set.");
        return [];
    }

    const all = getAllCharacters();
    // Only scan characters whose Personality (description) is filled.
    const eligible = all.filter((c) => c.description && c.description.trim().length > 0);
    const skipped = all.length - eligible.length;

    if (eligible.length === 0) {
        toastr?.info?.("No characters have a Personality filled in — nothing to scan.");
        return [];
    }

    dlog(`[RST] Lock scan: ${eligible.length} eligible, ${skipped} skipped (no personality)`);

    const pastSummaries = getAllSceneSummaries();
    const results = [];

    for (const char of eligible) {
        try {
            const proposed = await scanOneCharacter(char, pastSummaries, profileName);
            const hard = (proposed && proposed.hardLocks) || [];
            const soft = (proposed && proposed.softLocks) || [];
            if (hard.length > 0 || soft.length > 0) {
                results.push({
                    characterId: char.id,
                    characterName: char.name,
                    hardLocks: hard,
                    softLocks: soft,
                });
            }
        } catch (err) {
            console.error(`[RST] Lock scan failed for ${char.name}:`, err);
        }
    }

    return results;
}

/**
 * Ask the LLM to propose locks for a single character.
 */
async function scanOneCharacter(char, pastSummaries, profileName) {
    const systemPrompt = [
        "You set relationship-stat locks for a character based on their established psychology.",
        "There are TWO lock types:",
        "- HARD lock: a stat CANNOT rise above the cap through ordinary growth — a deep, trait-level limit (e.g. a profoundly guarded character who cannot trust past ~40%). Broken only by a rare critical moment.",
        "- SOFT lock: a stat is capped UNTIL the user fulfills a specific narrative condition you define, then it auto-unlocks (e.g. romantic.affection capped at 45 until they share several genuine meals together).",
        "Output ONLY a JSON object: { \"hardLocks\": [ { \"stat\": \"category.stat\", \"cap\": NUMBER, \"reason\": \"...\" } ], \"softLocks\": [ { \"stat\": \"category.stat\", \"cap\": NUMBER, \"condition\": \"...\", \"progress\": \"...\" } ] }",
        "Categories: platonic, romantic, sexual. Stats: trust, openness, support, affection.",
        "Rules:",
        "- Propose locks ONLY when the character's stated personality/notes strongly justify them. Most characters need FEW or ZERO of either type.",
        "- Ground every lock in the provided personality text. Never invent traits not present.",
        "- Use a HARD lock for fixed trait ceilings; use a SOFT lock when deeper growth should be earned through a specific milestone.",
        "- cap is -100 to 100. Do NOT set a cap below the stat's current value.",
        "- If nothing is justified, return { \"hardLocks\": [], \"softLocks\": [] }.",
    ].join("\n");

    const parts = [];
    parts.push(`CHARACTER: ${char.name}`);
    parts.push(`PERSONALITY: ${char.description}`);
    if (char.notes && char.notes.trim()) parts.push(`NOTES: ${char.notes}`);

    parts.push("\nCURRENT STATS:");
    for (const cat of STAT_CATEGORIES) {
        const s = char.stats[cat];
        parts.push(`  ${cat}: trust=${s.trust}%, openness=${s.openness}%, support=${s.support}%, affection=${s.affection}%`);
    }

    // Existing caps (don't re-propose what's already set)
    const existing = [];
    if (char.hardLocks) {
        for (const cat of STAT_CATEGORIES) {
            for (const stat of STAT_NAMES) {
                const lk = char.hardLocks[cat]?.[stat];
                if (lk && typeof lk.cap === "number") existing.push(`${cat}.${stat}=${lk.cap}%`);
            }
        }
    }
    if (existing.length > 0) {
        parts.push(`\nEXISTING CAPS (already set — only propose NEW or tighter ones): ${existing.join(", ")}`);
    }

    // A little scene context for grounding (kept short to save tokens)
    if (pastSummaries && pastSummaries.length > 0) {
        const recent = pastSummaries.slice(-4).map((s, i) => `  [${i}] ${typeof s === "string" ? s : (s.summary || s.llmSummary || "")}`);
        parts.push("\nRECENT SCENE CONTEXT (for grounding only):");
        parts.push(...recent);
    }

    parts.push("\nReturn JSON only.");

    const userPrompt = parts.join("\n");
    const resultText = await makeRequest(profileName, systemPrompt, userPrompt, 400);
    if (!resultText) return [];

    const parsed = extractLockJson(resultText);
    if (!parsed) return { hardLocks: [], softLocks: [] };

    // Back-compat: an older response may use { locks: [...] } for hard locks.
    const rawHard = Array.isArray(parsed.hardLocks) ? parsed.hardLocks
        : (Array.isArray(parsed.locks) ? parsed.locks : []);
    const rawSoft = Array.isArray(parsed.softLocks) ? parsed.softLocks : [];

    const validHard = [];
    for (const l of rawHard) {
        if (!l || typeof l.stat !== "string" || typeof l.cap !== "number") continue;
        const [cat, stat] = l.stat.toLowerCase().split(".");
        if (!STAT_CATEGORIES.includes(cat) || !STAT_NAMES.includes(stat)) continue;
        let cap = Math.max(-100, Math.min(100, Math.round(l.cap)));
        const cur = char.stats[cat]?.[stat] ?? 0;
        if (cap < cur) cap = cur; // never cap below current value
        validHard.push({ stat: `${cat}.${stat}`, cap, reason: (l.reason || "").toString().slice(0, 240) });
    }

    const validSoft = [];
    for (const l of rawSoft) {
        if (!l || typeof l.stat !== "string" || typeof l.cap !== "number") continue;
        const [cat, stat] = l.stat.toLowerCase().split(".");
        if (!STAT_CATEGORIES.includes(cat) || !STAT_NAMES.includes(stat)) continue;
        if (!l.condition || !String(l.condition).trim()) continue; // soft lock needs a condition
        let cap = Math.max(-100, Math.min(100, Math.round(l.cap)));
        const cur = char.stats[cat]?.[stat] ?? 0;
        if (cap < cur) cap = cur;
        validSoft.push({ stat: `${cat}.${stat}`, cap, condition: String(l.condition).slice(0, 300), progress: (l.progress || "").toString().slice(0, 300) });
    }

    return { hardLocks: validHard, softLocks: validSoft };
}

/**
 * Minimal JSON extractor for the lock-scan response.
 */
function extractLockJson(text) {
    const raw = String(text).trim();
    // Try fenced or raw
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fence ? fence[1].trim() : raw;
    try {
        return JSON.parse(candidate);
    } catch (e) {
        // Greedy first { ... last }
        const start = candidate.indexOf("{");
        const end = candidate.lastIndexOf("}");
        if (start !== -1 && end > start) {
            try {
                return JSON.parse(candidate.slice(start, end + 1));
            } catch (e2) { /* fall through */ }
        }
    }
    return null;
}
