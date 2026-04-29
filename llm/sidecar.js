/**
 * sidecar.js — Sidecar LLM: character presence detection
 * Calls a lightweight LLM to detect character names in recent messages
 */

import { chat } from "../../../../../script.js";
import { makeRequest } from "./connections.js";
import { getSettings } from "../data/storage.js";
import { getAllCharacters } from "../data/characters.js";

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
        'Detect all character names in these messages:',
        '- Include ALL characters who appear or are referenced, not just speakers.',
        '- Exclude the user/player character name.',
        '- Exclude generic titles (like "the man", "a woman").',
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
 * @param {string[]} detectedNames
 * @param {string[]} knownNames
 * @returns {{detected: string[], unknown: string[]}}
 */
function categorizeNames(detectedNames, knownNames) {
    const knownLower = knownNames.map((n) => n.toLowerCase().trim());
    const detected = [];
    const unknown = [];

    for (const name of detectedNames) {
        const nameLower = name.toLowerCase().trim();
        if (knownLower.includes(nameLower)) {
            detected.push(name);
        } else {
            unknown.push(name);
        }
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
    return chat.slice(-count);
}
