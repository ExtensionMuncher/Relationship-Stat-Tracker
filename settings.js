import { invalidateChatScopes } from "./lib/chatScope.js";
import { getChatData, persistChatData, getCharacters, saveAllCharacters } from "./data/storage.js";
import { validateProfile } from "./data/characters.js";
import { updateInjection } from "./inject/promptInjector.js";
import { captureChatScope } from "./lib/chatScope.js";
/**
 * settings.js — Settings management for RST
 * Handles initialization, loading, and saving of extension settings
 */

import { saveSettingsDebounced } from "../../../../script.js";
import { getSettings, getDefaultSettings, saveSetting, saveAllSettings, persistSettings } from "./data/storage.js";
import { dlog } from "./lib/debug.js";

// ─── Initialization ───────────────────────────────────────

/**
 * Initialize RST settings. Called once on extension load.
 * Merges defaults with any existing saved settings.
 */
export async function initSettings() {
    const rstScope1 = captureChatScope();

    const current = getSettings();
    const defaults = getDefaultSettings();

    // Merge defaults into current (preserves user values, adds new fields)
    const merged = deepMerge(defaults, current);
    saveAllSettings(merged);

    dlog("[RST] Settings initialized");
}

// ─── Public API ───────────────────────────────────────────

/**
 * Get a setting value by key path.
 * @param {string} key - Dot-notation path (e.g. "connections.statUpdateLLM")
 * @param {*} [defaultValue] - Fallback if not found
 * @returns {*}
 */
export function getSetting(key, defaultValue = undefined) {
    const settings = getSettings();
    const parts = key.split(".");
    let obj = settings;
    for (const part of parts) {
        if (obj === undefined || obj === null) return defaultValue;
        obj = obj[part];
    }
    return obj !== undefined ? obj : defaultValue;
}

/**
 * Set a setting value and persist.
 * @param {string} key - Dot-notation path
 * @param {*} value
 */
export function setSetting(key, value) {
    saveSetting(key, value);
}

/**
 * Check if the extension is enabled.
 * @returns {boolean}
 */
export function isEnabled() {
    return getSetting("enabled", true);
}

/**
 * Toggle the extension enabled state.
 * @param {boolean} [enabled] - Force state
 */
export function toggleEnabled(enabled) {
    const newState = enabled !== undefined ? enabled : !isEnabled();
    saveSetting("enabled", newState);
    return newState;
}

/**
 * Get the stat change range setting.
 * @returns {{min: number, max: number}}
 */
export function getStatChangeRange() {
    return getSetting("statChangeRange", { min: -5, max: 5 });
}

/**
 * Get the scan frequency setting.
 * @returns {number}
 */
export function getScanFrequency() {
    return getSetting("scanFrequency", 5);
}

/**
 * Get connection profile names for the three LLM roles.
 * @returns {{statUpdateLLM: string, sidecarLLM: string, autoGenLLM: string}}
 */
export function getConnectionNames() {
    return getSetting("connections", {
        statUpdateLLM: "",
        sidecarLLM: "",
        autoGenLLM: "",
    });
}

/**
 * Get injection settings.
 * @returns {object}
 */
export function getInjectionSettings() {
    return getSetting("injection", {
        injectStats: true,
        injectProfile: true,
        format: "stats_and_narrative",
        placement: "above_card",
    });
}

// ─── Import/Export ────────────────────────────────────────

/**
 * Export all RST data (settings + characters) as a JSON string.
 * @returns {string}
 */
export async function exportAllData() {
    return JSON.stringify({ settings: getSettings(), characters: getCharacters(), chatData: getChatData(), version: "0.1.24", exportedAt: new Date().toISOString() }, null, 2);
}

export async function importAllData(jsonString) {
    try {
        const data = JSON.parse(jsonString, (key, value) => ["__proto__", "constructor", "prototype"].includes(key) ? undefined : value);
        if (!data || !data.settings || typeof data.settings !== "object" || Array.isArray(data.settings)) throw new Error("Invalid settings object.");
        const importedCharacters = data.chatData?.characters ?? data.characters;
        if (!importedCharacters || typeof importedCharacters !== "object" || Array.isArray(importedCharacters)) throw new Error("Invalid character map.");
        for (const [id, profile] of Object.entries(importedCharacters)) {
            const errors = validateProfile(profile);
            if (errors.length) throw new Error(`${id}: ${errors.join("; ")}`);
            profile.id = id;
        }
        if (data.chatData !== undefined) {
            if (!data.chatData || typeof data.chatData !== "object" || Array.isArray(data.chatData)) throw new Error("Invalid chat data.");
            for (const field of ["scenes", "folders", "presentCharacters", "nameBlacklist"]) {
                if (data.chatData[field] !== undefined && !Array.isArray(data.chatData[field])) throw new Error(`Invalid ${field}.`);
            }
        }
        const settings = deepMerge(getDefaultSettings(), data.settings);
        saveAllSettings(settings);
        if (data.chatData) {
            const current = getChatData();
            for (const key of Object.keys(current)) delete current[key];
            Object.assign(current, data.chatData, { characters: importedCharacters });
            // Re-run namespace migration after assignment so legacy internal-only
            // fields (including old inertia diagnostics) are stripped immediately.
            getChatData();
            persistChatData();
        } else {
            saveAllCharacters(importedCharacters); // legacy backup
            getChatData();
            persistChatData();
        }
        invalidateChatScopes();
        updateInjection();
        return true;
    } catch (err) {
        console.error("[RST] Failed to import data:", err);
        return false;
    }
}

// ─── Helpers ──────────────────────────────────────────────

/**
 * Deep merge two objects. Source values override target values.
 * Target values are preserved for keys not in source.
 * @param {object} target
 * @param {object} source
 * @returns {object}
 */
function deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source || {})) {
        if (["__proto__", "constructor", "prototype"].includes(key)) continue;
        if (target[key] && typeof target[key] === "object" && !Array.isArray(target[key]) && (!source[key] || typeof source[key] !== "object" || Array.isArray(source[key]))) continue;
        if (
            source[key] &&
            typeof source[key] === "object" &&
            !Array.isArray(source[key]) &&
            target[key] &&
            typeof target[key] === "object" &&
            !Array.isArray(target[key])
        ) {
            result[key] = deepMerge(target[key], source[key]);
        } else {
            result[key] = source[key];
        }
    }
    return result;
}
