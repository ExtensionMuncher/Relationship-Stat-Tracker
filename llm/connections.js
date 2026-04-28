/**
 * connections.js — ST connection profile integration
 * Provides access to ST's connection manager profiles for LLM calls
 * Uses ConnectionManagerRequestService for per-profile API calls without
 * switching the global active profile.
 * Sets internal generation flag to prevent passive library reference injection
 * during RST's own LLM requests (pattern adapted from timeline-memory).
 */

import { getContext } from "../../../../extensions.js";
import { ConnectionManagerRequestService } from "../../../../extensions/shared.js";
import { setRSTInternalGen } from "../inject/promptInjector.js";

// ─── Connection Profile Access ────────────────────────────

/**
 * Get all available connection profiles from ST's connection manager.
 * @returns {Array<{name: string, id: string}>}
 */
export function getConnectionProfiles() {
    try {
        const ctx = getContext();
        const cm = ctx.extensionSettings?.connectionManager;
        if (!cm?.profiles) return [];

        return cm.profiles.map((p) => ({
            name: p.name || "Unnamed",
            id: p.id || p.name,
        }));
    } catch {
        return [];
    }
}

/**
 * Get a specific connection profile by name.
 * @param {string} profileName
 * @returns {object|null}
 */
export function getConnectionProfile(profileName) {
    if (!profileName) return null;

    try {
        const ctx = getContext();
        const cm = ctx.extensionSettings?.connectionManager;
        if (!cm?.profiles) return null;

        return cm.profiles.find((p) => p.name === profileName || p.id === profileName) || null;
    } catch {
        return null;
    }
}

// ─── LLM Request API ──────────────────────────────────────

/**
 * Make an LLM request using a specific connection profile.
 * Uses ST's ConnectionManagerRequestService.sendRequest() to route the request
 * through the selected profile without changing the global active profile.
 *
 * Uses the same 5-argument pattern as timeline-memory's genSummaryWithSlash():
 *   1. profileId
 *   2. messages (array of {role, content} objects)
 *   3. maxTokens
 *   4. customOptions { includePreset, includeInstruct, stream }
 *   5. overridePayload (e.g., { max_tokens })
 *
 * @param {string} profileId - The profile ID to use for the request
 * @param {string} systemPrompt - System-level prompt text
 * @param {string} userPrompt - User-level prompt text
 * @param {number} [maxTokens=500] - Maximum response tokens
 * @returns {Promise<string|null>} The response text, or null on failure
 */
export async function makeRequest(profileId, systemPrompt, userPrompt, maxTokens = 500) {
    if (!profileId) {
        console.warn("[RST] No connection profile specified for LLM request (profileId was:", JSON.stringify(profileId), ")");
        toastr?.warning?.("No connection profile selected. Check Settings > Connection profiles.");
        return null;
    }

    if (!userPrompt && !systemPrompt) {
        console.warn("[RST] No prompt content provided for LLM request");
        return null;
    }

    // Mark internal generation to suppress passive library reference self-injection
    setRSTInternalGen(true);

    try {
        // Build messages array in ST-compatible format (matching timeline-memory pattern)
        const messages = [];
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }
        if (userPrompt) {
            messages.push({ role: 'user', content: userPrompt });
        }

        // Build override payload with max_tokens
        const overridePayload = {
            max_tokens: maxTokens,
        };

        const response = await ConnectionManagerRequestService.sendRequest(
            profileId,            // 1. profileId
            messages,             // 2. messages array [{role, content}, ...]
            maxTokens,            // 3. maxTokens
            {                     // 4. customOptions
                includePreset: true,
                includeInstruct: true,
                stream: false,
            },
            overridePayload,      // 5. overridePayload
        );

        // Extract content from response — handle multiple response formats
        if (typeof response === "string") {
            return response;
        }

        if (response && typeof response === "object") {
            // ST ChatCompletion format: { choices: [{ message: { content, reasoning? } }] }
            if (response.choices && Array.isArray(response.choices) && response.choices[0]?.message?.content !== undefined) {
                const content = response.choices[0].message.content;
                const reasoning = response.choices[0].message.reasoning;
                // Reasoning models (e.g. deepseek-reasoner) may return empty content with reasoning field
                if (content || !reasoning) {
                    return content;
                }
                return reasoning;
            }
            // Simple { content: "..." } format (TextCompletion or some ST versions)
            if (response.content !== undefined) {
                // Reasoning models may return empty content with reasoning at top level
                return response.content || response.reasoning || '';
            }
            // Some ST versions may use different field names
            if (response.response) {
                return response.response;
            }
        }

        console.warn("[RST] Unexpected response format from ConnectionManagerRequestService:", response);
        return null;
    } catch (err) {
        console.error(`[RST] LLM request failed for profile "${profileId}":`, err);
        toastr?.error?.(`LLM request failed. Check your connection settings for "${profileId}".`);
        return null;
    } finally {
        // Restore normal injection state regardless of success/failure
        setRSTInternalGen(false);
    }
}
