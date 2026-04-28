/**
 * characters.js — Character profile CRUD + stat storage
 * All character profiles are stored per-chat in chat_metadata.rst.characters
 */

import {
    getCharacters,
    getCharacter as getStoredCharacter,
    saveCharacter,
    deleteCharacterData,
    saveAllCharacters,
    getSettings,
} from "./storage.js";

// ─── Constants ────────────────────────────────────────────

export const STAT_CATEGORIES = ["platonic", "romantic", "sexual"];
export const STAT_NAMES = ["trust", "openness", "support", "affection"];
export const MAX_UPDATE_LOG = 5;

// ─── Factory ──────────────────────────────────────────────

/**
 * Create a blank stat block with all 12 stats set to 0.
 * @returns {object}
 */
export function createBlankStats() {
    const stats = {};
    for (const cat of STAT_CATEGORIES) {
        stats[cat] = {};
        for (const stat of STAT_NAMES) {
            stats[cat][stat] = 0;
        }
    }
    return stats;
}

/**
 * Create a new character profile.
 * @param {string} name - Character display name
 * @param {object} [options] - Optional overrides
 * @returns {object} The new profile
 */
export function createCharacter(name, options = {}) {
    const id = generateCharacterId(name);

    const profile = {
        id,
        name,
        description: options.description || "",
        notes: options.notes || "",
        source: options.source || "manual", // "manual" | "character_card" | "auto_generated"

        stats: options.stats || createBlankStats(),

        dynamicTitle: options.dynamicTitle || "",
        narrativeSummary: options.narrativeSummary || "",

        updateLog: [],
    };

    saveCharacter(id, profile);
    return profile;
}

/**
 * Generate a stable character ID from a name.
 * @param {string} name
 * @returns {string}
 */
function generateCharacterId(name) {
    const normalized = name
        .toLowerCase()
        .trim()
        .replace(/\s+/g, "_")
        .replace(/[^a-z0-9_]/g, "");
    // Add a short hash for uniqueness
    const hash = simpleHash(name);
    return `char_${normalized}_${hash}`;
}

/**
 * Simple string hash for generating unique IDs.
 * @param {string} str
 * @returns {string} 4-char hex string
 */
function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16).slice(0, 4).padStart(4, "0");
}

// ─── Read Operations ──────────────────────────────────────

/**
 * Get a character profile by ID.
 * @param {string} charId
 * @returns {object|null}
 */
export function getCharacterProfile(charId) {
    return getStoredCharacter(charId);
}

/**
 * Get all character profiles as an array.
 * @returns {Array<object>}
 */
export function getAllCharacters() {
    const map = getCharacters();
    return Object.values(map);
}

/**
 * Find a character by exact name (case-insensitive).
 * @param {string} name
 * @returns {object|null}
 */
export function findCharacterByName(name) {
    const all = getAllCharacters();
    const lowerName = name.toLowerCase().trim();
    return all.find((c) => c.name.toLowerCase().trim() === lowerName) || null;
}

/**
 * Search for characters whose names fuzzy-match the query.
 * @param {string} query
 * @returns {Array<object>}
 */
export function searchCharacters(query) {
    const all = getAllCharacters();
    const lowerQuery = query.toLowerCase().trim();
    return all.filter((c) => c.name.toLowerCase().includes(lowerQuery));
}

// ─── Update Operations ────────────────────────────────────

/**
 * Update a character's stats directly.
 * @param {string} charId
 * @param {object} newStats - Full stats object (all 12 stats)
 */
export function updateCharacterStats(charId, newStats) {
    const profile = getStoredCharacter(charId);
    if (!profile) return;
    profile.stats = clampAllStats(newStats);
    saveCharacter(charId, profile);
}

/**
 * Apply a stat delta (additive change) to a character.
 * Values are clamped to [-100, 100] and delta is clamped to statChangeRange.
 * @param {string} charId
 * @param {object} delta - { platonic: { trust: 5 }, romantic: { affection: -3 } }
 * @param {object} [rangeOverride] - { min, max } override for statChangeRange
 * @returns {object} The updated profile
 */
export function applyStatDelta(charId, delta, rangeOverride = null) {
    const profile = getStoredCharacter(charId);
    if (!profile) return null;

    const settings = getSettings();
    const range = rangeOverride || settings.statChangeRange || { min: -5, max: 5 };

    for (const cat of STAT_CATEGORIES) {
        if (!delta[cat]) continue;
        for (const stat of STAT_NAMES) {
            if (delta[cat][stat] === undefined) continue;
            // Clamp the delta to the allowed range
            let change = delta[cat][stat];
            change = Math.max(range.min, Math.min(range.max, change));
            // Apply and clamp final value to [-100, 100]
            profile.stats[cat][stat] = Math.max(-100, Math.min(100, profile.stats[cat][stat] + change));
        }
    }

    saveCharacter(charId, profile);
    return profile;
}

/**
 * Update a character's profile fields (non-stats).
 * @param {string} charId
 * @param {object} updates - Fields to update
 */
export function updateCharacterProfile(charId, updates) {
    const profile = getStoredCharacter(charId);
    if (!profile) return;

    const allowedFields = ["name", "description", "notes", "source", "dynamicTitle", "narrativeSummary"];
    for (const field of allowedFields) {
        if (updates[field] !== undefined) {
            profile[field] = updates[field];
        }
    }

    saveCharacter(charId, profile);
}

/**
 * Add an update log entry to a character.
 * Keeps only the last MAX_UPDATE_LOG entries.
 * @param {string} charId
 * @param {object} logEntry - UpdateLogEntry from the architecture plan
 */
export function addUpdateLogEntry(charId, logEntry) {
    const profile = getStoredCharacter(charId);
    if (!profile) return;

    profile.updateLog.unshift(logEntry);
    if (profile.updateLog.length > MAX_UPDATE_LOG) {
        profile.updateLog = profile.updateLog.slice(0, MAX_UPDATE_LOG);
    }

    saveCharacter(charId, profile);
}

/**
 * Remove a specific update log entry by sceneId.
 * @param {string} charId
 * @param {string} sceneId
 */
export function removeUpdateLogEntry(charId, sceneId) {
    const profile = getStoredCharacter(charId);
    if (!profile) return;

    profile.updateLog = profile.updateLog.filter((entry) => entry.sceneId !== sceneId);
    saveCharacter(charId, profile);
}

// ─── Delete ───────────────────────────────────────────────

/**
 * Delete a character profile entirely.
 * @param {string} charId
 */
export function deleteCharacter(charId) {
    deleteCharacterData(charId);
}

// ─── Import/Export ────────────────────────────────────────

/**
 * Export all character data as a JSON string.
 * @returns {string}
 */
export function exportCharacters() {
    const chars = getCharacters();
    return JSON.stringify(chars, null, 2);
}

/**
 * Import character data from a JSON string.
 * Merges with existing data (existing characters are overwritten if same ID).
 * @param {string} jsonString
 * @returns {number} Number of characters imported
 */
export function importCharacters(jsonString) {
    try {
        const imported = JSON.parse(jsonString);
        if (typeof imported !== "object" || imported === null) {
            throw new Error("Invalid character data format");
        }

        const existing = getCharacters();
        let count = 0;
        for (const [id, profile] of Object.entries(imported)) {
            if (profile && profile.name) {
                existing[id] = profile;
                count++;
            }
        }

        saveAllCharacters(existing);
        return count;
    } catch (err) {
        console.error("[RST] Failed to import characters:", err);
        return -1;
    }
}

// ─── Helpers ──────────────────────────────────────────────

/**
 * Clamp all stat values to [-100, 100].
 * @param {object} stats
 * @returns {object} Clamped stats
 */
function clampAllStats(stats) {
    const clamped = {};
    for (const cat of STAT_CATEGORIES) {
        clamped[cat] = {};
        for (const stat of STAT_NAMES) {
            const val = stats[cat]?.[stat] ?? 0;
            clamped[cat][stat] = Math.max(-100, Math.min(100, val));
        }
    }
    return clamped;
}

/**
 * Get the initials from a character name (for avatar display).
 * @param {string} name
 * @returns {string} 1-2 character initials
 */
export function getInitials(name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
        return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
}

/**
 * Deep clone a stats object.
 * @param {object} stats
 * @returns {object}
 */
export function cloneStats(stats) {
    const clone = {};
    for (const cat of STAT_CATEGORIES) {
        clone[cat] = { ...stats[cat] };
    }
    return clone;
}
