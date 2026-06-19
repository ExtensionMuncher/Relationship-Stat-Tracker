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
import { makeRequest, getPersonaContext } from "./connections.js";
import { dlog } from "../lib/debug.js";

// Max characters preserved for lock free-text fields (reason/condition/progress).
// Generous so psychologically detailed locks are never chopped after a complete
// LLM response. Truncation beyond this only guards against pathological output.
const LOCK_TEXT_MAX = 1500;

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
    // Only scan characters whose Personality (description) is filled...
    const withPersona = all.filter((c) => c.description && c.description.trim().length > 0);
    const noPersonaCount = all.length - withPersona.length;

    // ...AND that do not already have ANY lock set. Characters with existing
    // hard or soft locks are excluded so a re-scan never overwrites or stacks
    // onto what is already configured. Clear a character's locks manually if
    // you want them reconsidered.
    const alreadyLocked = (c) => {
        const has = (map) => {
            if (!map) return false;
            for (const cat of STAT_CATEGORIES) for (const stat of STAT_NAMES) {
                const e = map[cat]?.[stat];
                if (e && typeof e.cap === "number") return true;
            }
            return false;
        };
        return has(c.hardLocks) || has(c.softLocks);
    };
    const eligible = withPersona.filter((c) => !alreadyLocked(c));
    const lockedSkipped = withPersona.length - eligible.length;

    if (eligible.length === 0) {
        const why = noPersonaCount > 0 && lockedSkipped > 0
            ? "Every character either has no Personality filled in or already has locks set."
            : lockedSkipped > 0
                ? "Every eligible character already has locks set. Clear a character's locks to re-scan them."
                : "No characters have a Personality filled in — nothing to scan.";
        toastr?.info?.(why, "Relationship Stat Tracker");
        return [];
    }

    dlog(`[RST] Lock scan: ${eligible.length} eligible, ${noPersonaCount} skipped (no personality), ${lockedSkipped} skipped (already locked)`);

    const pastSummaries = getAllSceneSummaries();
    const results = [];
    let errorCount = 0;
    let proposedNoneCount = 0;

    for (const char of eligible) {
        try {
            const proposed = await scanOneCharacter(char, pastSummaries, profileName);
            if (proposed && proposed.error) { errorCount++; continue; }
            const hard = (proposed && proposed.hardLocks) || [];
            const soft = (proposed && proposed.softLocks) || [];
            if (hard.length > 0 || soft.length > 0) {
                results.push({
                    characterId: char.id,
                    characterName: char.name,
                    hardLocks: hard,
                    softLocks: soft,
                });
            } else {
                proposedNoneCount++;
            }
        } catch (err) {
            errorCount++;
            console.error(`[RST] Lock scan failed for ${char.name}:`, err);
        }
    }

    dlog(`[RST] Lock scan complete: ${eligible.length} scanned, ${results.length} with proposals, ${proposedNoneCount} returned none, ${errorCount} errored.`);
    // If every character errored, that is a real failure (connection/parse), not
    // a legitimate "no locks needed" result — tell the user so they can act.
    if (errorCount > 0 && results.length === 0) {
        toastr?.warning?.(`Lock scan hit errors on ${errorCount} character(s) and got no usable proposals. Check the console (F12) — likely a connection or response-format issue with the Stat Update LLM.`, "Relationship Stat Tracker", { timeOut: 9000 });
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
        "- Be CONSERVATIVE. Locks are exceptional, not routine. A typical character warrants 0-3 locks TOTAL, reserved for the few stats where their psychology creates a genuine, defining ceiling. Do not lock a stat just because it could plausibly be limited — only when NOT locking it would misrepresent who they are.",
        "- Never lock a stat merely because it is currently low; low stats can still grow naturally. Lock only true trait-level barriers.",
        "- Prefer leaving a stat unlocked when in doubt. An empty result for a character is a perfectly valid and common outcome.",
        "- Ground every lock in the provided personality text. Never invent traits not present.",
        "- Use a HARD lock for fixed trait ceilings; use a SOFT lock when deeper growth should be earned through a specific milestone.",
        "- cap is -100 to 100. Do NOT set a cap below the stat's current value.",
        "- If nothing is justified, return { \"hardLocks\": [], \"softLocks\": [] }.",
    ].join("\n");

    const parts = [];
    parts.push(`CHARACTER: ${char.name}`);
    parts.push(`PERSONALITY: ${char.description}`);
    if (char.notes && char.notes.trim()) parts.push(`NOTES: ${char.notes}`);

    // Persona context — soft-lock conditions are about what the USER must do,
    // so name the user explicitly and include their persona description if set.
    const persona = getPersonaContext();
    parts.push(`\nTHE USER (the person this character relates to): ${persona.name}`);
    if (persona.description) parts.push(`USER PERSONA: ${persona.description}`);
    parts.push(`When writing soft-lock conditions, refer to the user as "${persona.name}" rather than a generic "the user".`);

    // Current relationship dynamic — the title + narrative capture where this
    // relationship stands right now, which grounds soft-lock conditions in the
    // actual arc rather than personality alone.
    if (char.dynamicTitle && char.dynamicTitle.trim()) {
        parts.push(`\nCURRENT DYNAMIC: ${char.dynamicTitle}`);
    }
    if (char.narrativeSummary && char.narrativeSummary.trim()) {
        parts.push(`CURRENT NARRATIVE: ${char.narrativeSummary}`);
    }

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
    const resultText = await makeRequest(profileName, systemPrompt, userPrompt, 20000, 0.3);
    if (!resultText) {
        dlog(`[RST] Lock scan: no response for ${char.name}`);
        return { hardLocks: [], softLocks: [], error: "no_response" };
    }
    dlog(`[RST] Lock scan raw response for ${char.name}:`, resultText.slice(0, 500));

    const parsed = extractLockJson(resultText);
    if (!parsed) {
        dlog(`[RST] Lock scan: could not parse JSON for ${char.name}. Raw:`, resultText.slice(0, 300));
        return { hardLocks: [], softLocks: [], error: "parse_failed" };
    }

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
        const hardReasonRaw = String(l.reason || "").trim();
        const hardReasonStored = hardReasonRaw.slice(0, LOCK_TEXT_MAX);
        if (hardReasonRaw.length > hardReasonStored.length) {
            dlog(`[RST] Lock scan: hard reason for ${cat}.${stat} TRUNCATED by extension slice — raw ${hardReasonRaw.length} chars, stored ${hardReasonStored.length}. Raise LOCK_TEXT_MAX if this is unwanted.`);
        } else {
            dlog(`[RST] Lock scan: hard reason for ${cat}.${stat} stored intact (${hardReasonStored.length} chars).`);
        }
        validHard.push({ stat: `${cat}.${stat}`, cap, reason: hardReasonStored });
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
        const condRaw = String(l.condition || "").trim();
        const condStored = condRaw.slice(0, LOCK_TEXT_MAX);
        const progRaw = String(l.progress || "").trim();
        const progStored = progRaw.slice(0, LOCK_TEXT_MAX);
        if (condRaw.length > condStored.length || progRaw.length > progStored.length) {
            dlog(`[RST] Lock scan: soft text for ${cat}.${stat} TRUNCATED by extension slice — condition raw ${condRaw.length}/stored ${condStored.length}, progress raw ${progRaw.length}/stored ${progStored.length}.`);
        } else {
            dlog(`[RST] Lock scan: soft text for ${cat}.${stat} stored intact (condition ${condStored.length}, progress ${progStored.length} chars).`);
        }
        validSoft.push({ stat: `${cat}.${stat}`, cap, condition: condStored, progress: progStored });
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
