/**
 * profileGen.js — Main LLM: character profile auto-generation
 * Generates character descriptions, notes, and initial stats from scene context
 */

import { chat, getContext } from "../../../../../script.js";
import { makeRequest } from "./connections.js";
import { getSettings } from "../data/storage.js";
import { getAllSceneSummaries } from "../data/scenes.js";
import { STAT_CATEGORIES, STAT_NAMES } from "../data/characters.js";

// ─── Profile Generation ───────────────────────────────────

/**
 * Generate a character profile using the auto-gen LLM.
 * @param {string} characterName - Name of the character to generate
 * @param {string} [prompt=""] - Optional user guidance prompt
 * @param {boolean} [fromScene=false] - Whether to generate from scene context only
 * @returns {Promise<object>} Generated profile data
 */
export async function generateProfile(characterName, prompt = "", fromScene = false) {
    const settings = getSettings();
    const profileName = settings.connections.autoGenLLM;

    const systemPrompt = buildProfileGenSystemPrompt();
    const requestPrompt = buildProfileGenRequestPrompt(characterName, prompt, fromScene);

    try {
        toastr?.info?.("Generating character profile...");

        const result = await makeRequest(
            profileName,
            systemPrompt + "\n\n" + requestPrompt,
            1000,
        );

        if (!result) throw new Error("No response from LLM");

        const parsed = parseProfileResponse(result);
        return {
            name: characterName,
            ...parsed,
            source: "auto_generated",
        };
    } catch (err) {
        console.error("[RST] Profile generation failed:", err);
        toastr?.error?.("Character profile generation failed. Please try again.");
        throw err;
    }
}

// ─── Prompt Building ──────────────────────────────────────

/**
 * Build the system prompt for profile generation.
 * @returns {string}
 */
function buildProfileGenSystemPrompt() {
    return `You are a character analysis assistant. Your job is to create a character profile based on how they appear in roleplay messages.

Generate:
1. A description (2-3 sentences about the character's personality, role, and key traits)
2. Notes (practical observations about how they behave, what motivates them)
3. Initial relationship stats (all 12 stats as percentages from -100 to 100)
4. A dynamic title (short phrase like "The Reluctant Ally")
5. A narrative summary (1-2 sentences about the relationship trajectory)

STAT CATEGORIES:
- Platonic: trust, openness, support, affection
- Romantic: trust, openness, support, affection
- Sexual: trust, openness, support, affection

# PERSPECTIVE RULE (CRITICAL):
- All stats represent how [Character] feels toward {{user}} — NOT the other way around!
- For example, "trust: 30%" means this character trusts {{user}} at 30%, NOT that {{user}} trusts them
- Stats are ALWAYS measured from the character's perspective toward {{user}}
- Description, notes, dynamic title, and narrative summary should all describe the character's relationship with {{user}}
- Never generate stats from {{user}}'s perspective toward a character

RESPONSE FORMAT — return ONLY valid JSON:
{
  "description": "Character description...",
  "notes": "Behavioral notes...",
  "stats": {
    "platonic": { "trust": X, "openness": X, "support": X, "affection": X },
    "romantic": { "trust": X, "openness": X, "support": X, "affection": X },
    "sexual": { "trust": X, "openness": X, "support": X, "affection": X }
  },
  "dynamicTitle": "The [Adjective] [Noun]",
  "narrativeSummary": "Brief relationship assessment."
}`;
}

/**
 * Build the request prompt for profile generation.
 * @param {string} characterName
 * @param {string} prompt
 * @param {boolean} fromScene
 * @returns {string}
 */
function buildProfileGenRequestPrompt(characterName, prompt, fromScene) {
    const parts = [];

    parts.push(`Generate a profile for the character: "${characterName}"`);

    if (prompt) {
        parts.push(`\nUSER GUIDANCE: ${prompt}`);
    }

    if (fromScene || !prompt) {
        // Include recent chat context
        const recentMessages = getRecentMessages(20);
        if (recentMessages.length > 0) {
            const userName = getContext().name1 || "User";
            parts.push(`\nRECENT CHAT MESSAGES ("${userName}" is the user/player, other named speakers are characters):`);
            recentMessages.forEach((m, i) => {
                const speaker = m.name || "Unknown";
                const text = (m.mes || "").slice(0, 300);
                const isUser = m.is_user ? " [USER]" : "";
                parts.push(`[${i}]${isUser} ${speaker}: ${text}`);
            });
        }

        // Include past scene summaries
        const summaries = getAllSceneSummaries();
        if (summaries.length > 0) {
            parts.push("\nPAST SCENE SUMMARIES:");
            summaries.forEach((s) => {
                parts.push(`[${s.id}]: ${s.summary}`);
            });
        }
    }

    return parts.join("\n");
}

// ─── Response Parsing ─────────────────────────────────────

/**
 * Parse the LLM response into a profile object.
 * @param {string} response
 * @returns {object}
 */
function parseProfileResponse(response) {
    let parsed;
    try {
        parsed = JSON.parse(response.trim());
    } catch {
        const match = response.match(/\{[\s\S]*\}/);
        if (match) {
            parsed = JSON.parse(match[0]);
        } else {
            throw new Error("Failed to parse profile response as JSON");
        }
    }

    return {
        description: parsed.description || "",
        notes: parsed.notes || "",
        stats: parsed.stats || createZeroStats(),
        dynamicTitle: parsed.dynamicTitle || "",
        narrativeSummary: parsed.narrativeSummary || "",
    };
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

/**
 * Create a zero stats object.
 * @returns {object}
 */
function createZeroStats() {
    const stats = {};
    for (const cat of STAT_CATEGORIES) {
        stats[cat] = {};
        for (const stat of STAT_NAMES) {
            stats[cat][stat] = 0;
        }
    }
    return stats;
}
