/**
 * sidecar.js — Sidecar LLM: character presence detection
 * Calls a lightweight LLM to detect character names in recent messages
 */

import { chat } from "../../../../../script.js";
import { getContext } from "../../../../extensions.js";
import { makeRequest } from "./connections.js";
import { getSettings } from "../data/storage.js";
import { getAllCharacters, getCharacterNameVariants, findCharacterByFuzzyName } from "../data/characters.js";

// ─── Sidecar Detection ────────────────────────────────────

/**
 * Run sidecar detection on recent messages.
 * @param {number} [messageCount=10] - How many recent messages to scan
 * @returns {Promise<{detected: string[], unknown: string[]}>} detected = known names, unknown = new names
 */
export async function detectCharacters(messageCount = 10) {
    const settings = getSettings();
    if (!settings.enabled) return { detected: [], unknown: [] };

    const profileName = settings.connections.sidecarLLM;
    const messages = getRecentMessages(messageCount);

    if (messages.length === 0) return { detected: [], unknown: [] };

    const knownCharacters = getAllCharacters();
    const knownNames = knownCharacters.map((c) => c.name);

    const systemPrompt = buildSidecarSystemPrompt();
    const requestPrompt = buildSidecarRequestPrompt(messages, knownNames);

    console.log("[RST] detectCharacters: using profile=" + profileName + ", messages=" + messages.length + ", knownNames=" + knownNames.length);

    try {
        const result = await makeRequest(
            profileName,
            systemPrompt,
            requestPrompt,
            200,
        );

        console.log("[RST] detectCharacters: LLM response received, result=" + (result ? result.substring(0, 100) : "null"));

        if (!result) return { detected: [], unknown: [] };

        const detectedNames = parseDetectedNames(result);
        console.log("[RST] detectCharacters: parsed names:", JSON.stringify(detectedNames));
        return categorizeNames(detectedNames, knownNames);
    } catch (err) {
        console.error("[RST] Sidecar detection failed:", err);
        toastr?.error?.("Sidecar character detection failed. Check your connection settings.");
        return { detected: [], unknown: [] };
    }
}

// ─── Prompt Building ──────────────────────────────────────

/**
 * Build the system prompt for the sidecar LLM.
 * @param {string[]} knownNames - Already-known character names
 * @returns {string}
 */
function buildSidecarSystemPrompt() {
    return 'You are a character name detection assistant. Identify all character names mentioned in chat messages. Output ONLY a JSON array of name strings.';
}

/**
 * Build the request prompt with recent messages.
 * @param {Array} messages
 * @returns {string}
 */
function buildSidecarRequestPrompt(messages, knownNames) {
    const lines = messages.map((m, i) => {
        const speaker = m.name || "Unknown";
        const text = (m.mes || "").slice(0, 500);
        return `[${i}] ${speaker}: ${text}`;
    });

    const parts = [
        'Identify ALL named characters who appear, speak, or interact in these messages — even briefly:',
        '- INCLUDE characters who: speak dialogue, are addressed by name, perform actions described by another speaker, are described as interacting with someone in the scene, or are described as being physically present or doing an activity.',
        '- For example: if a character says "I talked with [Name] yesterday" or "[Name] handed me the package," INCLUDE [Name].',
        '- Only EXCLUDE characters who are merely mentioned in passing as a topic of conversation without being described as interacting or doing anything.',
        '- Exclude the user/player character name.',
        '- Exclude generic titles (like "the man", "a woman").',
        '- CRITICAL: Ignore names mentioned as incorrect guesses, forgotten names, or wrong memories in internal thoughts.',
        '- Each name should appear only once.',
    ];

    if (knownNames.length > 0) {
        parts.push(`- Already-known characters (include if present): ${knownNames.join(", ")}`);
    }

    parts.push('');
    parts.push(...lines);

    return parts.join('\n');
}

// ─── Response Parsing ─────────────────────────────────────

/**
 * Parse the LLM response into an array of names.
 * @param {string} response - Raw LLM output
 * @returns {string[]} Detected character names
 */
function parseDetectedNames(response) {
    if (!response || typeof response !== "string") return [];

    // Try to extract a JSON array from the response
    try {
        // First, try direct parse
        const parsed = JSON.parse(response.trim());
        if (Array.isArray(parsed)) {
            return parsed.filter((n) => typeof n === "string" && n.trim().length > 0);
        }
    } catch {
        // Try to find a JSON array in the response
        const match = response.match(/\[[\s\S]*?\]/);
        if (match) {
            try {
                const parsed = JSON.parse(match[0]);
                if (Array.isArray(parsed)) {
                    return parsed.filter((n) => typeof n === "string" && n.trim().length > 0);
                }
            } catch {
                // Fall through to line-based parsing
            }
        }

        // Fallback: split by commas/newlines
        return response
            .split(/[,|\n]+/)
            .map((s) => s.trim().replace(/^["'\d.\s]+/, "").replace(/["']$/, "").trim())
            .filter((s) => s.length > 0 && s.length < 50);
    }

    return [];
}

/**
 * Categorize detected names into known and unknown.
 * Filters out blacklisted names (from settings) and persona/user names.
 * @param {string[]} detectedNames
 * @param {string[]} knownNames
 * @returns {{detected: string[], unknown: string[]}}
 */
function categorizeNames(detectedNames, knownNames) {
    const allCharacters = getAllCharacters();

    // Build exclusion set: persona name + settings blacklist + hardcoded placeholders
    const settings = getSettings();
    const personaName = (getContext().name1 || "").toLowerCase().trim();
    const blacklistNames = (settings.nameBlacklist || []).map((n) => n.toLowerCase().trim()).filter(Boolean);
    const excludedNames = new Set(["{{user}}", "user", "User", personaName, ...blacklistNames]);

    // Helper: check if a name should be excluded
    function isExcluded(name) {
        const n = (name || "").toLowerCase().trim();
        return !n || excludedNames.has(n);
    }

    // Build a flat map: every known name variant → character profile
    const knownVariants = new Map(); // lowercased variant name → character
    for (const char of allCharacters) {
        const variants = getCharacterNameVariants(char);
        for (const v of variants) {
            if (!knownVariants.has(v)) {
                knownVariants.set(v, char);
            }
        }
    }

    const detected = [];
    const unknown = [];

    for (const name of detectedNames) {
        if (isExcluded(name)) continue;
        const nameLower = name.toLowerCase().trim();
        if (!nameLower) continue;

        // 1. Exact match against any variant (main name or alias)
        const exactChar = knownVariants.get(nameLower);
        if (exactChar) {
            detected.push(exactChar.name);
            continue;
        }

        // 2. Fuzzy match (word-set + substring) against all character profiles
        const fuzzyChar = findCharacterByFuzzyName(name);
        if (fuzzyChar) {
            detected.push(fuzzyChar.name);
            continue;
        }

        // 3. No match found — truly unknown
        unknown.push(name);
    }

    return { detected, unknown };
}

// ─── Helpers ──────────────────────────────────────────────

/**
 * Get the N most recent chat messages.
 * @param {number} count
 * @returns {Array}
 */
function getRecentMessages(count) {
    if (!chat || !Array.isArray(chat)) return [];

    // Filter out ST-hidden messages (is_system=true) to only scan visible chat,
    // mirroring how ST's Generate() builds coreChat = chat.filter(x => !x.is_system ...)
    const visibleMessages = chat.filter((m) => !m.is_system);
    return visibleMessages.slice(-count);
}
