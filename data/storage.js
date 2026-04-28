/**
 * storage.js — ST storage API wrapper
 * Handles extension_settings.rst and chat_metadata.rst
 */

import { chat_metadata, saveSettingsDebounced, saveChatDebounced } from "../../../../../script.js";
import { extension_settings } from "../../../../../scripts/extensions.js";

const NAMESPACE = "rst";

// ─── Extension Settings (Global) ──────────────────────────

/**
 * Get the RST namespace from extension_settings.
 * Initializes it if missing.
 */
function ensureSettingsNamespace() {
    if (!extension_settings[NAMESPACE]) {
        extension_settings[NAMESPACE] = {
            settings: getDefaultSettings(),
        };
    }
    if (!extension_settings[NAMESPACE].settings) {
        extension_settings[NAMESPACE].settings = getDefaultSettings();
    }
}

/**
 * Get all RST extension settings.
 * @returns {object} The settings object
 */
export function getSettings() {
    ensureSettingsNamespace();
    return extension_settings[NAMESPACE].settings;
}

/**
 * Save a single setting value.
 * @param {string} key - Dot-notation path (e.g. "connections.statUpdateLLM")
 * @param {*} value
 */
export function saveSetting(key, value) {
    ensureSettingsNamespace();
    const parts = key.split(".");
    let obj = extension_settings[NAMESPACE].settings;
    for (let i = 0; i < parts.length - 1; i++) {
        if (obj[parts[i]] === undefined) obj[parts[i]] = {};
        obj = obj[parts[i]];
    }
    obj[parts[parts.length - 1]] = value;
    saveSettingsDebounced();
}

/**
 * Replace all settings at once.
 * @param {object} newSettings
 */
export function saveAllSettings(newSettings) {
    ensureSettingsNamespace();
    extension_settings[NAMESPACE].settings = newSettings;
    saveSettingsDebounced();
}

/**
 * Persist extension settings to disk.
 */
export function persistSettings() {
    saveSettingsDebounced();
}

// ─── Character Profiles (Per-Chat) ────────────────────────

/**
 * Get all character profiles for the current chat.
 * @returns {object} Map of character ID → profile
 */
export function getCharacters() {
    ensureChatNamespace();
    if (!chat_metadata[NAMESPACE].characters) {
        chat_metadata[NAMESPACE].characters = {};
    }
    return chat_metadata[NAMESPACE].characters;
}

/**
 * Get a single character profile by ID for the current chat.
 * @param {string} charId
 * @returns {object|null}
 */
export function getCharacter(charId) {
    ensureChatNamespace();
    return chat_metadata[NAMESPACE].characters?.[charId] || null;
}

/**
 * Save a character profile to the current chat.
 * @param {string} charId
 * @param {object} profile
 */
export function saveCharacter(charId, profile) {
    ensureChatNamespace();
    if (!chat_metadata[NAMESPACE].characters) {
        chat_metadata[NAMESPACE].characters = {};
    }
    chat_metadata[NAMESPACE].characters[charId] = profile;
    saveChatDebounced();
}

/**
 * Delete a character profile from the current chat.
 * @param {string} charId
 */
export function deleteCharacterData(charId) {
    ensureChatNamespace();
    if (chat_metadata[NAMESPACE].characters) {
        delete chat_metadata[NAMESPACE].characters[charId];
        saveChatDebounced();
    }
}

/**
 * Replace all character data for the current chat.
 * @param {object} characters Map of charId → profile
 */
export function saveAllCharacters(characters) {
    ensureChatNamespace();
    chat_metadata[NAMESPACE].characters = characters;
    saveChatDebounced();
}

// ─── Per-Chat Data ────────────────────────────────────────

/**
 * Ensure the RST namespace exists in chat_metadata.
 */
function ensureChatNamespace() {
    if (!chat_metadata[NAMESPACE]) {
        chat_metadata[NAMESPACE] = {
            scenes: [],
            pendingUpdates: null,
            presentCharacters: [],
            messageCounter: 0,
            characters: {},
        };
    }
}

/**
 * Get the full RST chat data object.
 * @returns {object}
 */
export function getChatData() {
    ensureChatNamespace();
    return chat_metadata[NAMESPACE];
}

/**
 * Get scenes array for this chat.
 * @returns {Array}
 */
export function getScenes() {
    ensureChatNamespace();
    return chat_metadata[NAMESPACE].scenes;
}

/**
 * Save the scenes array.
 * @param {Array} scenes
 */
export function saveScenes(scenes) {
    ensureChatNamespace();
    chat_metadata[NAMESPACE].scenes = scenes;
    saveChatDebounced();
}

/**
 * Get pending updates for this chat.
 * @returns {object|null}
 */
export function getPendingUpdates() {
    ensureChatNamespace();
    return chat_metadata[NAMESPACE].pendingUpdates;
}

/**
 * Save pending updates.
 * @param {object|null} pending
 */
export function savePendingUpdates(pending) {
    ensureChatNamespace();
    chat_metadata[NAMESPACE].pendingUpdates = pending;
    saveChatDebounced();
}

/**
 * Get present characters for this chat.
 * @returns {Array<string>} Array of character IDs
 */
export function getPresentCharacters() {
    ensureChatNamespace();
    return chat_metadata[NAMESPACE].presentCharacters || [];
}

/**
 * Save present characters list.
 * @param {Array<string>} charIds
 */
export function savePresentCharacters(charIds) {
    ensureChatNamespace();
    chat_metadata[NAMESPACE].presentCharacters = charIds;
    saveChatDebounced();
}

/**
 * Get the message counter for sidecar scan frequency.
 * @returns {number}
 */
export function getMessageCounter() {
    ensureChatNamespace();
    return chat_metadata[NAMESPACE].messageCounter || 0;
}

/**
 * Increment and save the message counter.
 * @returns {number} New counter value
 */
export function incrementMessageCounter() {
    ensureChatNamespace();
    chat_metadata[NAMESPACE].messageCounter = (chat_metadata[NAMESPACE].messageCounter || 0) + 1;
    saveChatDebounced();
    return chat_metadata[NAMESPACE].messageCounter;
}

/**
 * Reset the message counter.
 */
export function resetMessageCounter() {
    ensureChatNamespace();
    chat_metadata[NAMESPACE].messageCounter = 0;
    saveChatDebounced();
}

/**
 * Persist chat data to disk.
 */
export function persistChatData() {
    saveChatDebounced();
}

// ─── Default Settings ─────────────────────────────────────

/**
 * Returns the default settings object.
 * @returns {object}
 */
export function getDefaultSettings() {
    return {
        enabled: true,

        connections: {
            statUpdateLLM: "",
            sidecarLLM: "",
            autoGenLLM: "",
        },

        scanFrequency: 5,
        newCharPopup: true,
        statChangeRange: { min: -5, max: 5 },
        sceneSummaryPrompt:
            "Write a concise scene summary for internal reference. Include: key events, emotional turning points, characters present, and any significant relationship shifts. Keep it clinical and factual — this is a note for future analysis, not a narrative retelling.",

        batchScan: {
            sceneDetectionMaxTokens: 4000,
            initialStatMaxTokens: 3000,
            chunkSize: 100,
        },

        injection: {
            injectStats: true,
            injectProfile: true,
            format: "stats_and_narrative",
            placement: "above_card",
            passiveLibraryRef: false,
            libraryRefDepth: 2,
            libraryRefRole: "system",
        },
    };
}
