/**
 * connections.js — ST connection profile integration
 * Provides access to ST's connection manager profiles for LLM calls
 * Uses ConnectionManagerRequestService for per-profile API calls without
 * switching the global active profile.
 */

import { getContext } from "../../../../extensions.js";
import { ConnectionManagerRequestService } from "../../../../extensions/shared.js";

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
 * @param {string} profileId - The profile ID to use for the request
 * @param {string} prompt - The full prompt text (system + user)
 * @param {number} [maxTokens=500] - Maximum response tokens
 * @returns {Promise<string|null>} The response text, or null on failure
 */
export async function makeRequest(profileId, prompt, maxTokens = 500) {
    if (!profileId) {
        console.warn("[RST] No connection profile specified for LLM request");
        toastr?.warning?.("No connection profile selected. Check Settings > Connection profiles.");
        return null;
    }

    try {
        const response = await ConnectionManagerRequestService.sendRequest(
            profileId,
            prompt,
            maxTokens,
        );

        if (typeof response === "string") {
            return response;
        }

        // sendRequest may return an object with a 'response' field
        if (response && typeof response === "object" && response.response) {
            return response.response;
        }

        console.warn("[RST] Unexpected response format from ConnectionManagerRequestService:", response);
        return null;
    } catch (err) {
        console.error(`[RST] LLM request failed for profile "${profileId}":`, err);
        toastr?.error?.(`LLM request failed. Check your connection settings for "${profileId}".`);
        return null;
    }
}
