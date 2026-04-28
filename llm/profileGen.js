/**
 * profileGen.js — Main LLM: character profile auto-generation
 * Generates character descriptions, notes, and initial stats from scene context
 */

import { chat } from "../../../../../script.js";
import { getContext } from "../../../../extensions.js";
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

    console.log("[RST] generateProfile called for:", characterName, "profileName:", JSON.stringify(profileName), "prompt length:", prompt?.length, "fromScene:", fromScene);

    if (!profileName) {
        console.error("[RST] No autoGenLLM connection profile configured!");
        toastr?.error?.("Auto-generation: No LLM connection profile configured. Go to Settings → Connections and set Auto-Gen LLM.");
        throw new Error("autoGenLLM profile not configured");
    }

    const systemPrompt = buildProfileGenSystemPrompt();
    const requestPrompt = buildProfileGenRequestPrompt(characterName, prompt, fromScene);

    console.log("[RST] Profile gen system prompt:", systemPrompt.slice(0, 200) + "...");
    console.log("[RST] Profile gen request prompt length:", requestPrompt.length);

    try {
        toastr?.info?.("Generating character profile...");

        const result = await makeRequest(
            profileName,
            systemPrompt,
            requestPrompt,
            1000,
        );

        console.log("[RST] Profile gen raw response (first 500 chars):", result?.slice(0, 500));
        console.log("[RST] Profile gen raw response (last 200 chars):", result?.slice(-200));

        if (!result) throw new Error("No response from LLM");

        const parsed = parseProfileResponse(result);
        console.log("[RST] Profile gen parsed:", JSON.stringify(parsed).slice(0, 200));

        return {
            name: characterName,
            ...parsed,
            source: "auto_generated",
        };
    } catch (err) {
        console.error("[RST] Profile generation failed:", err);
        toastr?.error?.("Character profile generation failed: " + (err.message || "Unknown error"));
        throw err;
    }
}

// ─── Prompt Building ──────────────────────────────────────

/**
 * Build the system prompt for profile generation.
 * @returns {string}
 */
function buildProfileGenSystemPrompt() {
    return [
        'You are a character profile generator.',
        'Your response must be a single valid JSON object. Nothing else.',
        '',
        'Required fields:',
        '- description: string — 2-3 sentences about personality, role, and key traits',
        '- notes: string — practical observations about behavior and motivation',
        '- stats: object with categories platonic, romantic, sexual.',
        '  Each category has: trust, openness, support, affection as integers -100 to 100',
        '- dynamicTitle: string — short title like "The Reluctant Ally"',
        '- narrativeSummary: string — 1-2 sentences on relationship trajectory',
        '',
        'CRITICAL PERSPECTIVE RULE:',
        'All stats represent how [Character] feels toward {{user}}, NOT the other way around.',
        '',
        'RULES:',
        '- Start your response with {',
        '- End your response with }',
        '- No markdown, no backticks, no code fences',
        '- No analysis, explanation, or narration of your process',
        '- If you include anything besides the JSON object, the response will be rejected',
    ].join('\n');
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

    // Forceful JSON output instruction at the very end (critical position)
    parts.push('\n\n---\nRESPOND WITH ONLY A VALID JSON OBJECT.\nStart with {, end with }. No markdown, no explanation, no analysis, no backticks.\nYour entire response must be parseable as JSON.');

    return parts.join("\n");
}

// ─── Response Parsing ─────────────────────────────────────

/**
 * Parse the LLM response into a profile object.
 * Handles reasoning model output (```json code fences, prepended thinking, etc.)
 * @param {string} response
 * @returns {object}
 */
function parseProfileResponse(response) {
    let parsed;
    const text = response.trim();

    // Strategy 1: Direct JSON parse
    try {
        parsed = JSON.parse(text);
        console.log("[RST] Profile parse: strategy 1 (direct) succeeded");
        return extractProfileFields(parsed);
    } catch {
        // continue to next strategy
    }

    // Strategy 2: Extract from ```json ... ``` code fence
    const jsonFenceMatch = text.match(/```json\s*([\s\S]*?)```/);
    if (jsonFenceMatch) {
        try {
            parsed = JSON.parse(jsonFenceMatch[1].trim());
            console.log("[RST] Profile parse: strategy 2 (json fence) succeeded");
            return extractProfileFields(parsed);
        } catch {
            // continue to next strategy
        }
    }

    // Strategy 3: Extract from ``` ... ``` generic code fence
    const fenceMatch = text.match(/```\s*([\s\S]*?)```/);
    if (fenceMatch) {
        try {
            parsed = JSON.parse(fenceMatch[1].trim());
            console.log("[RST] Profile parse: strategy 3 (generic fence) succeeded");
            return extractProfileFields(parsed);
        } catch {
            // continue to next strategy
        }
    }

    // Strategy 4: Greedy extract from first { to last }
    const braceMatch = text.match(/\{[\s\S]*\}/);
    if (braceMatch) {
        try {
            parsed = JSON.parse(braceMatch[0]);
            console.log("[RST] Profile parse: strategy 4 (greedy braces) succeeded");
            return extractProfileFields(parsed);
        } catch {
            // continue to next strategy
        }
    }

    // Strategy 5: Try progressive trimming to find valid JSON
    for (let end = text.lastIndexOf('}'); end > text.indexOf('{'); end = text.lastIndexOf('}', end - 1)) {
        const start = text.indexOf('{');
        if (start >= 0 && end > start) {
            try {
                parsed = JSON.parse(text.substring(start, end + 1));
                console.log("[RST] Profile parse: strategy 5 (progressive trim) succeeded");
                return extractProfileFields(parsed);
            } catch {
                continue;
            }
        }
    }

    // Strategy 6: Fallback — parse analysis text format (bullet-point stats, Description/Notes sections)
    console.log("[RST] Profile parse: no JSON found, attempting analysis text fallback parser");
    const fallback = parseAnalysisTextFallback(text);
    if (fallback) {
        console.log("[RST] Profile parse: strategy 6 (analysis text fallback) succeeded");
        return fallback;
    }

    console.error("[RST] Failed to parse profile response. First 500 chars:", text.slice(0, 500));
    console.error("[RST] Last 500 chars:", text.slice(-500));
    throw new Error("Failed to parse profile response as JSON");
}

/**
 * Fallback parser for when the model outputs analysis text instead of JSON.
 * Extracts Description, Notes, and bullet-point stats from the analysis format.
 * @param {string} text
 * @returns {object|null}
 */
function parseAnalysisTextFallback(text) {
    try {
        // Extract Description: looks for **Description:** followed by text
        let description = "";
        const descMatch = text.match(/\*{1,2}Description\*{1,2}:\s*(.+?)(?:\n\s*\*|\n\s*\n|$)/i);
        if (descMatch) {
            description = descMatch[1].trim();
        }

        // Extract Notes: looks for **Notes:** followed by text
        let notes = "";
        const notesMatch = text.match(/\*{1,2}Notes\*{1,2}:\s*(.+?)(?:\n\s*\*|\n\s*\n|$)/i);
        if (notesMatch) {
            notes = notesMatch[1].trim();
        }

        // Extract stats from bullet-point format:
        // *   *Platonic:*
        //     *   Trust: 65 (...)
        //     *   Openness: 55 (...)
        const stats = createZeroStats();
        const categories = ['platonic', 'romantic', 'sexual'];
        const statNames = ['trust', 'openness', 'support', 'affection'];

        for (const cat of categories) {
            // Find the category section
            const catRegex = new RegExp('\\*{1,2}\\s*' + cat + '\\s*\\*{1,2}\\s*:', 'i');
            const catMatch = text.match(catRegex);
            if (!catMatch) continue;

            // Get text from this category to the next category (or end)
            const catIndex = catMatch.index;
            const nextCatStart = (() => {
                let nextIdx = text.length;
                for (const otherCat of categories) {
                    if (otherCat === cat) continue;
                    const re = new RegExp('\\*{1,2}\\s*' + otherCat + '\\s*\\*{1,2}\\s*:', 'i');
                    const m = text.match(re);
                    if (m && m.index > catIndex && m.index < nextIdx) {
                        nextIdx = m.index;
                    }
                }
                return nextIdx;
            })();
            const catSection = text.substring(catIndex, nextCatStart);

            // Extract stat values from this section
            for (const stat of statNames) {
                const statRegex = new RegExp('\\*\\s*' + stat + '\\s*:\\s*(-?\\d+)', 'i');
                const statMatch = catSection.match(statRegex);
                if (statMatch) {
                    const value = parseInt(statMatch[1], 10);
                    stats[cat][stat] = Math.max(-100, Math.min(100, value));
                }
            }
        }

        // Check if we got anything useful
        const hasAnyStats = Object.values(stats).some(cat =>
            Object.values(cat).some(v => v !== 0)
        );
        const hasDesc = description.length > 0;

        if (hasAnyStats || hasDesc) {
            return {
                description,
                notes,
                stats,
                dynamicTitle: "",
                narrativeSummary: "",
            };
        }

        return null;
    } catch (err) {
        console.warn("[RST] Analysis text fallback parser failed:", err.message);
        return null;
    }
}

/**
 * Extract profile fields from a parsed JSON object with defaults.
 * @param {object} parsed
 * @returns {object}
 */
function extractProfileFields(parsed) {
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
