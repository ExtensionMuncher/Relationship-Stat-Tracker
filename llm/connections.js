/**
 * connections.js — ST connection profile integration
 * Provides access to ST's connection manager profiles for LLM calls
 * Uses ConnectionManagerRequestService for per-profile API calls without
 * switching the global active profile.
 * Sets internal generation flag to prevent passive library reference injection
 * during RST's own LLM requests (pattern adapted from timeline-memory).
 *
 * Also provides rate limiting with exponential backoff, retry logic,
 * and a progress callback mechanism for batch scan operations.
 */

import { getContext } from "../../../../extensions.js";
import { ConnectionManagerRequestService } from "../../../../extensions/shared.js";
import { setRSTInternalGen } from "../inject/promptInjector.js";

// ─── Rate Limiter ───────────────────────────────────────────

/**
 * Sliding-window rate limiter with exponential backoff retry.
 * Tracks request timestamps per connection profile (independent windows).
 */
export class RateLimiter {
    constructor(options = {}) {
        this.requestsPerMinute = options.requestsPerMinute || 10;
        this.maxRetries = options.maxRetries ?? 3;
        this.baseDelayMs = options.baseDelayMs || 1000;
        this.maxDelayMs = 60000;
        /** @type {Map<string, number[]>} per-profile sliding windows */
        this.windows = new Map();
    }

    /**
     * Wait until a request is allowed under the rate limit for the given profile.
     * Removes expired timestamps, checks count against limit, and waits if needed.
     * @param {string} profileId
     */
    async acquire(profileId) {
        const now = Date.now();
        if (!this.windows.has(profileId)) {
            this.windows.set(profileId, []);
        }
        const timestamps = this.windows.get(profileId);
        // Remove timestamps older than 60 seconds
        const cutoff = now - 60000;
        while (timestamps.length > 0 && timestamps[0] < cutoff) {
            timestamps.shift();
        }
        if (timestamps.length >= this.requestsPerMinute) {
            // Wait until the oldest timestamp expires + 100ms safety buffer
            const waitMs = timestamps[0] + 60000 - now + 100;
            if (waitMs > 0) {
                console.log(`[RST] Rate limit reached for "${profileId}". Waiting ${Math.ceil(waitMs)}ms...`);
                await new Promise(r => setTimeout(r, waitMs));
                // Re-acquire after waiting (recursive but depth-limited to 1)
                return this.acquire(profileId);
            }
        }
        this.windows.get(profileId).push(Date.now());
    }

    /**
     * Execute an async function with retry logic.
     * Automatically acquires rate limit tokens and retries on transient errors.
     * @param {string} profileId
     * @param {Function} fn - Async function to execute
     * @returns {Promise<*>}
     */
    async executeWithRetry(profileId, fn) {
        let lastError;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            await this.acquire(profileId);
            try {
                const result = await fn();
                return result;
            } catch (err) {
                lastError = err;
                if (attempt >= this.maxRetries) break;
                if (!isRetryable(err)) throw err;
                const delay = Math.min(
                    this.baseDelayMs * Math.pow(2, attempt) + Math.random() * 1000,
                    this.maxDelayMs
                );
                console.log(`[RST] Retry ${attempt + 1}/${this.maxRetries} for "${profileId}" in ${Math.ceil(delay)}ms: ${err.message || err}`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
        throw lastError;
    }
}

/**
 * Determine if an error is retryable (rate limit, server error, or network failure).
 * @param {Error} err
 * @returns {boolean}
 */
function isRetryable(err) {
    // Direct status code
    if (err?.status === 429) return true;
    if (err?.status === 502) return true;
    if (err?.status === 503) return true;
    if (err?.status === 0) return true; // network error
    // Error message patterns
    const msg = (err?.message || '').toLowerCase();
    if (msg.includes('rate limit') || msg.includes('too many requests')) return true;
    if (msg.includes('timeout') || msg.includes('timed out')) return true;
    if (msg.includes('network') || msg.includes('econnrefused')) return true;
    if (msg.includes('bad gateway') || msg.includes('service unavailable')) return true;
    if (msg.includes('internal server error')) return true;
    return false;
}

// ─── Singleton Instance ────────────────────────────────────

/** @type {RateLimiter} */
const rateLimiter = new RateLimiter();

/**
 * Update the rate limiter settings from extension settings.
 * Called during initialization and when settings change.
 * @param {object} batchSettings - The batchScan settings object
 */
export function updateRateLimiterSettings(batchSettings = {}) {
    rateLimiter.requestsPerMinute = batchSettings.requestsPerMinute ?? 10;
    rateLimiter.maxRetries = batchSettings.maxRetries ?? 3;
    rateLimiter.baseDelayMs = batchSettings.baseRetryDelay ?? 1000;
}

// ─── Progress Callback ─────────────────────────────────────

/** @type {Function|null} */
let progressCallback = null;

/**
 * Set a callback to receive progress updates during batch operations.
 * @param {Function|null} cb - Callback receiving { phase, totalPhases, label, current, total, detail, elapsed }
 */
export function setProgressCallback(cb) {
    progressCallback = cb;
}

/**
 * Report progress to the registered callback.
 * @param {object} data
 */
export function reportProgress(data) {
    if (progressCallback) {
        progressCallback(data);
    }
}

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
export async function makeRequest(profileId, systemPrompt, userPrompt, maxTokens = 500, temperature = null) {
    console.log("[RST] makeRequest called — profileId:", JSON.stringify(profileId), "hasSystemPrompt:", !!systemPrompt, "hasUserPrompt:", !!userPrompt, "maxTokens:", maxTokens, "temperature:", temperature);

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
        // Wrap the actual API call with rate limiter + retry logic
        const response = await rateLimiter.executeWithRetry(profileId, async () => {
            console.log(`[RST] Sending LLM request to profile "${profileId}"...`);

            // Build messages array in ST-compatible format (matching timeline-memory pattern)
            const messages = [];
            if (systemPrompt) {
                messages.push({ role: 'system', content: systemPrompt });
            }
            if (userPrompt) {
                messages.push({ role: 'user', content: userPrompt });
            }

            // Build override payload with max_tokens and optional temperature override
            const overridePayload = {
                max_tokens: maxTokens,
            };
            if (temperature !== null) {
                overridePayload.temperature = temperature;
            }

            return await ConnectionManagerRequestService.sendRequest(
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
        });

        // Extract content from response — handle multiple response formats
        if (typeof response === "string") {
            return response;
        }

        if (response && typeof response === "object") {
            // ST ChatCompletion format: { choices: [{ message: { content, reasoning? } }] }
            if (response.choices && Array.isArray(response.choices) && response.choices[0]?.message?.content !== undefined) {
                const content = response.choices[0].message.content;
                const reasoning = response.choices[0].message.reasoning;
                // Some providers (e.g. GLM/Ollama) return empty content with a reasoning field
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
        console.error(`[RST] LLM request failed for profile "${profileId}" after retries:`, err);
        toastr?.error?.(`LLM request failed after retries. Check your connection settings for "${profileId}".`);
        return null;
    } finally {
        // Restore normal injection state regardless of success/failure
        setRSTInternalGen(false);
    }
}
