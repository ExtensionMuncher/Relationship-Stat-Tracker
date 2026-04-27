/**
 * sidecar.js — Sidecar LLM: character presence detection
 * Calls a lightweight LLM to detect character names in recent messages
 */

import { generateRaw, chat, name1 } from "../../../../../script.js";
import { withProfile } from "./connections.js";
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

    const systemPrompt = buildSidecarSystemPrompt(knownNames);
    const requestPrompt = buildSidecarRequestPrompt(messages);

    try {
        const { restore } = await withProfile(profileName);

        let result;
        try {
            result = await generateRaw(
                systemPrompt,
                requestPrompt,
                false,
                false,
                null,
                200 // Short response — just a list of names
            );
        } finally {
            await restore();
        }

        const detectedNames = parseDetectedNames(result);
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
function buildSidecarSystemPrompt(knownNames) {
    return `You are a character name detection assistant. Your job is to identify all character names mentioned in the provided chat messages.

RULES:
1. Return ONLY a JSON array of character name strings. Example: ["Alice", "Bob"]
2. Include ALL characters who appear or are referenced — not just the speaker.
3. Do NOT include the user/player character name.
4. Do NOT include generic titles (like "the man", "a woman").
5. Each name should appear only once.
${knownNames.length > 0 ? `6. Already-known characters (still include them if present): ${knownNames.join(", ")}` : ""}

Respond with ONLY the JSON array, no other text.`;
}

/**
 * Build the request prompt with recent messages.
 * @param {Array} messages
 * @returns {string}
 */
function buildSidecarRequestPrompt(messages) {
    const lines = messages.map((m, i) => {
        const speaker = m.name || "Unknown";
        const text = (m.mes || "").slice(0, 500); // Truncate long messages
        return `[${i}] ${speaker}: ${text}`;
    });

    return `Detect all character names in these messages:\n\n${lines.join("\n")}`;
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
