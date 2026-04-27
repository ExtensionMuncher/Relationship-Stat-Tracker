/**
 * settings.js — Settings management for RST
 * Handles initialization, loading, and saving of extension settings
 */

import { saveSettingsDebounced } from "../../../script.js";
import { getSettings, getDefaultSettings, saveSetting, saveAllSettings, persistSettings } from "./data/storage.js";

// ─── Initialization ───────────────────────────────────────

/**
 * Initialize RST settings. Called once on extension load.
 * Merges defaults with any existing saved settings.
 */
export async function initSettings() {
    const current = getSettings();
    const defaults = getDefaultSettings();

    // Merge defaults into current (preserves user values, adds new fields)
    const merged = deepMerge(defaults, current);
    saveAllSettings(merged);

    console.log("[RST] Settings initialized");
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
export function exportAllData() {
    const data = {
        settings: getSettings(),
        characters: (await import("./data/storage.js")).getCharacters(),
        version: "0.1.0",
        exportedAt: new Date().toISOString(),
    };
    return JSON.stringify(data, null, 2);
}

/**
 * Import all RST data from a JSON string.
 * @param {string} jsonString
 * @returns {boolean} True if imported successfully
 */
export async function importAllData(jsonString) {
    try {
        const data = JSON.parse(jsonString);
        if (!data.settings || typeof data.settings !== "object") {
            throw new Error("Invalid data format: missing settings");
        }

        const { saveAllCharacters } = await import("./data/storage.js");

        // Import settings
        saveAllSettings(data.settings);

        // Import characters
        if (data.characters && typeof data.characters === "object") {
            saveAllCharacters(data.characters);
        }

        console.log("[RST] Data imported successfully");
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
    for (const key of Object.keys(source)) {
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
