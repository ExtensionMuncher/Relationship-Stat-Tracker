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
    getFolders,
    saveFolders,
} from "./storage.js";

// Re-export storage functions needed by the UI layer
export { getFolders, saveFolders };

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
 * Create a blank hard-lock map mirroring the stats shape.
 * Each entry is { cap: number|null, reason: string }.
 *   cap = null  -> no lock on this stat
 *   cap = N     -> this stat cannot rise above N through normal growth.
 *                  A critical change can push past it and RAISE the cap to the
 *                  new value (requiring a further critical to climb again).
 * A lock may also have a negative-direction floor via capLow (optional).
 */
export function createBlankLocks() {
    const locks = {};
    for (const cat of STAT_CATEGORIES) {
        locks[cat] = {};
        for (const stat of STAT_NAMES) {
            locks[cat][stat] = { cap: null, reason: "" };
        }
    }
    return locks;
}

export const HARD_LOCK_PRESSURE_MAX = 5;

/**
 * Create a blank pressure object for a hard lock. Pressure tracks EVIDENCE that
 * a character is acting against the psychological reason behind the lock. It
 * never raises the stat itself — at max it flags the lock for user review.
 *   value        0..max evidence level
 *   max          ceiling (default 5)
 *   reason       prose for the latest pressure change
 *   lastUpdated  timestamp of last change
 *   needsReview  true once value hits max
 *   recommendation  LLM-proposed review object (or null)
 *   history      past cap changes earned through pressure, so the LLM knows the
 *                cap was not always its current value and why it moved.
 */
export function createBlankPressure() {
    return {
        value: 0,
        max: HARD_LOCK_PRESSURE_MAX,
        reason: "",
        lastUpdated: 0,
        needsReview: false,
        recommendation: null,
        history: [],
    };
}

/**
 * Ensure a hard-lock entry has a pressure object IF it has a cap. Lockless
 * stats stay lean (no pressure attached). Returns the (possibly updated) entry.
 */
export function ensurePressure(lockEntry) {
    if (!lockEntry || typeof lockEntry.cap !== "number") return lockEntry;
    if (!lockEntry.pressure || typeof lockEntry.pressure !== "object") {
        lockEntry.pressure = createBlankPressure();
    } else {
        // Backfill any missing fields on an older pressure object.
        const p = lockEntry.pressure;
        if (typeof p.value !== "number") p.value = 0;
        if (typeof p.max !== "number") p.max = HARD_LOCK_PRESSURE_MAX;
        if (typeof p.reason !== "string") p.reason = "";
        if (typeof p.lastUpdated !== "number") p.lastUpdated = 0;
        if (typeof p.needsReview !== "boolean") p.needsReview = false;
        if (!("recommendation" in p)) p.recommendation = null;
        if (!Array.isArray(p.history)) p.history = [];
    }
    return lockEntry;
}

/**
 * Create a blank SOFT-lock map mirroring the stats shape.
 * Each entry is { cap: number|null, condition: string, progress: string, met: boolean }.
 *   cap = null      -> no soft lock on this stat
 *   cap = N         -> growth is blocked above N UNTIL the condition is met,
 *                      then the stat AUTO-unlocks and normal growth resumes.
 *   condition       -> the LLM-defined requirement to unlock (prose).
 *   progress        -> the LLM's running prose notes toward the condition.
 *   met             -> once true, the lock is satisfied and no longer gates growth.
 * Unlike hard locks, a soft lock is not broken by a critical — it is removed by
 * fulfilling its narrative condition.
 */
export function createBlankSoftLocks() {
    const locks = {};
    for (const cat of STAT_CATEGORIES) {
        locks[cat] = {};
        for (const stat of STAT_NAMES) {
            locks[cat][stat] = { cap: null, condition: "", progress: "", met: false, setAtScene: 0 };
        }
    }
    return locks;
}

export const SOFT_LOCK_COOLDOWN_SCENES = 5;

/**
 * Determine whether a character can receive a NEW soft lock right now.
 * Two gates:
 *   1. CAP: at most ONE active (unmet) soft lock per character at a time.
 *   2. COOLDOWN: at least SOFT_LOCK_COOLDOWN_SCENES closed scenes must have
 *      passed since the most recent soft lock was set or resolved.
 * @param {object} profile
 * @param {number} currentSceneCount - getClosedSceneCount() at evaluation time
 * @returns {{ allowed: boolean, reason: string, activeStat: string|null }}
 */
export function getSoftLockAvailability(profile, currentSceneCount) {
    if (!profile || !profile.softLocks) return { allowed: false, reason: "no profile", activeStat: null, slotsFree: 0 };
    // Configurable ceiling: 1-3 simultaneous active soft locks per character.
    // This is a MAX, not a target — the model is told to use 0..max as fitting.
    let maxActive = 1;
    try {
        const s = getSettings();
        if (s?.softLocks?.maxActive) maxActive = Math.max(1, Math.min(3, s.softLocks.maxActive));
    } catch (e) { /* default 1 */ }

    let activeCount = 0;
    let activeStat = null;
    let lastSetAt = 0;
    for (const cat of STAT_CATEGORIES) {
        for (const stat of STAT_NAMES) {
            const sl = profile.softLocks[cat]?.[stat];
            if (!sl || typeof sl.cap !== 'number') continue;
            if (!sl.met) { activeCount++; activeStat = `${cat}.${stat}`; }
            if (typeof sl.setAtScene === 'number') lastSetAt = Math.max(lastSetAt, sl.setAtScene);
        }
    }
    const slotsFree = Math.max(0, maxActive - activeCount);
    if (slotsFree <= 0) {
        return { allowed: false, reason: `at the soft-lock limit (${maxActive})`, activeStat, slotsFree: 0 };
    }
    const elapsed = currentSceneCount - lastSetAt;
    if (lastSetAt > 0 && elapsed < SOFT_LOCK_COOLDOWN_SCENES) {
        return { allowed: false, reason: `cooldown: ${SOFT_LOCK_COOLDOWN_SCENES - elapsed} more scene(s)`, activeStat, slotsFree: 0 };
    }
    return { allowed: true, reason: "", activeStat: null, slotsFree };
}

/**
 * Create a new character profile.
 * Checks for name collisions (same words in different order) and warns.
 * @param {string} name - Character display name
 * @param {object} [options] - Optional overrides
 * @returns {object} The new profile
 */
export function createCharacter(name, options = {}) {
    const id = generateCharacterId(name);

    // GUARD: if a profile already exists at this deterministic ID, return it
    // instead of overwriting. createCharacter() is called from detection/scan
    // paths whenever the LLM names a character — without this guard, re-detecting
    // an existing character clobbered its saved profile (aliases, stats, and
    // update log were silently wiped). Returning the existing profile is
    // backward-compatible: it only prevents destruction of saved data.
    const existing = getStoredCharacter(id);
    if (existing) {
        return existing;
    }

    // Check for name collisions (same words, different order) — different ID,
    // so not caught by the guard above. Warn but allow (user may genuinely want
    // a distinct profile).
    const similar = findCharacterBySimilarName(name);
    if (similar) {
        console.warn(`[RST] Name collision detected: "${name}" is similar to existing character "${similar.name}" (id=${similar.id})`);
        toastr?.warning?.(
            `A character with a similar name already exists: "${similar.name}". Consider using that profile instead of creating a duplicate.`,
            "RST Name Collision",
            { timeOut: 8000, closeButton: true }
        );
    }

    const profile = {
        id,
        name,
        nameAliases: options.nameAliases || [],
        description: options.description || "",
        notes: options.notes || "",
        source: options.source || "manual", // "manual" | "character_card" | "auto_generated"
        folderId: options.folderId || null,
        avatar: options.avatar || null,

        stats: options.stats || createBlankStats(),
        hardLocks: options.hardLocks || createBlankLocks(),
        softLocks: options.softLocks || createBlankSoftLocks(),
        suppressDescriptionInjection: options.suppressDescriptionInjection || false,
        suppressNotesInjection: options.suppressNotesInjection || false,

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
    return normalizeProfileLocks(getStoredCharacter(charId));
}

/**
 * Ensure a profile has the hardLocks map (added in the locks feature). Older
 * saved profiles predate this field; fill it in on read so the rest of the
 * code can assume it exists. Non-destructive — only adds missing structure.
 */
function normalizeProfileLocks(profile) {
    if (!profile) return profile;
    if (!profile.hardLocks) {
        profile.hardLocks = createBlankLocks();
    } else {
        for (const cat of STAT_CATEGORIES) {
            if (!profile.hardLocks[cat]) profile.hardLocks[cat] = {};
            for (const stat of STAT_NAMES) {
                if (!profile.hardLocks[cat][stat]) {
                    profile.hardLocks[cat][stat] = { cap: null, reason: "" };
                }
            }
        }
    }
    // Attach/backfill pressure on every hard lock that has a cap (migration for
    // existing locked characters). Lockless stats stay lean.
    for (const cat of STAT_CATEGORIES) {
        for (const stat of STAT_NAMES) {
            const e = profile.hardLocks[cat]?.[stat];
            if (e && typeof e.cap === "number") ensurePressure(e);
        }
    }
    // Soft locks (added later) — same backfill treatment.
    if (!profile.softLocks) {
        profile.softLocks = createBlankSoftLocks();
    } else {
        for (const cat of STAT_CATEGORIES) {
            if (!profile.softLocks[cat]) profile.softLocks[cat] = {};
            for (const stat of STAT_NAMES) {
                if (!profile.softLocks[cat][stat]) {
                    profile.softLocks[cat][stat] = { cap: null, condition: "", progress: "", met: false, setAtScene: 0 };
                }
            }
        }
    }
    return profile;
}

/**
 * Get all character profiles as an array.
 * @returns {Array<object>}
 */
export function getAllCharacters() {
    const map = getCharacters();
    return Object.values(map).map(normalizeProfileLocks);
}

/**
 * Find a character by exact name (case-insensitive), then aliases, then fuzzy.
 * Falls through progressively: exact match → alias match → word-set match → substring match.
 * @param {string} name
 * @returns {object|null}
 */
export function findCharacterByName(name) {
    const all = getAllCharacters();
    const lowerName = name.toLowerCase().trim();
    if (!lowerName) return null;

    // 1. Exact match on main name
    const exact = all.find((c) => c.name.toLowerCase().trim() === lowerName);
    if (exact) return exact;

    // 2. Exact match on any alias
    for (const c of all) {
        if (c.nameAliases && Array.isArray(c.nameAliases)) {
            const aliasMatch = c.nameAliases.some((a) => a.toLowerCase().trim() === lowerName);
            if (aliasMatch) return c;
        }
    }

    // 3. Word-set match (e.g., "Satoru Gojo" ↔ "Gojo Satoru")
    const nameWords = lowerName.split(/\s+/).filter(Boolean).sort().join(" ");
    for (const c of all) {
        const cWords = c.name.toLowerCase().trim().split(/\s+/).filter(Boolean).sort().join(" ");
        if (cWords === nameWords) return c;
        // Also check aliases with word-set matching
        if (c.nameAliases && Array.isArray(c.nameAliases)) {
            for (const alias of c.nameAliases) {
                const aliasWords = alias.toLowerCase().trim().split(/\s+/).filter(Boolean).sort().join(" ");
                if (aliasWords === nameWords) return c;
            }
        }
    }

    // 4. Substring match (e.g., "Gojo" matches inside "Satoru Gojo")
    for (const c of all) {
        // Check if the name is a substring of the character's main name, or vice versa
        const cNameLower = c.name.toLowerCase().trim();
        if (cNameLower.includes(lowerName) || lowerName.includes(cNameLower)) return c;
        // Also check aliases
        if (c.nameAliases && Array.isArray(c.nameAliases)) {
            for (const alias of c.nameAliases) {
                const aliasLower = alias.toLowerCase().trim();
                if (aliasLower.includes(lowerName) || lowerName.includes(aliasLower)) return c;
            }
        }
    }

    return null;
}

/**
 * Find a character by fuzzy name matching only (skips exact match).
 * Useful when comparing detected names against known names.
 * Uses word-set + substring matching + alias expansion.
 * @param {string} name
 * @returns {object|null}
 */
export function findCharacterByFuzzyName(name) {
    const all = getAllCharacters();
    const lowerName = name.toLowerCase().trim();
    if (!lowerName) return null;

    // 1. Word-set match
    const nameWords = lowerName.split(/\s+/).filter(Boolean).sort().join(" ");
    for (const c of all) {
        const cWords = c.name.toLowerCase().trim().split(/\s+/).filter(Boolean).sort().join(" ");
        if (cWords === nameWords) return c;
        if (c.nameAliases && Array.isArray(c.nameAliases)) {
            for (const alias of c.nameAliases) {
                const aliasWords = alias.toLowerCase().trim().split(/\s+/).filter(Boolean).sort().join(" ");
                if (aliasWords === nameWords) return c;
            }
        }
    }

    // 2. Substring match
    for (const c of all) {
        const cNameLower = c.name.toLowerCase().trim();
        if (cNameLower.includes(lowerName) || lowerName.includes(cNameLower)) return c;
        if (c.nameAliases && Array.isArray(c.nameAliases)) {
            for (const alias of c.nameAliases) {
                const aliasLower = alias.toLowerCase().trim();
                if (aliasLower.includes(lowerName) || lowerName.includes(aliasLower)) return c;
            }
        }
    }

    return null;
}

/**
 * Get all unique name strings for a character profile (main name + aliases).
 * Used for categorization and comparison.
 * @param {object} profile
 * @returns {string[]} Array of name strings (lowercased, trimmed)
 */
export function getCharacterNameVariants(profile) {
    const names = [profile.name.toLowerCase().trim()];
    if (profile.nameAliases && Array.isArray(profile.nameAliases)) {
        for (const alias of profile.nameAliases) {
            const a = alias.toLowerCase().trim();
            if (a && !names.includes(a)) names.push(a);
        }
    }
    return names;
}

/**
 * Find a character by word-set similarity (same words, different order).
 * Detects collisions like "Satoru Gojo" ↔ "Gojo Satoru".
 * @param {string} name
 * @returns {object|null}
 */
export function findCharacterBySimilarName(name) {
    const all = getAllCharacters();
    const normalizedWords = name.toLowerCase().trim().split(/\s+/).filter(Boolean).sort().join(" ");
    if (!normalizedWords) return null;

    for (const c of all) {
        const cWords = c.name.toLowerCase().trim().split(/\s+/).filter(Boolean).sort().join(" ");
        if (cWords === normalizedWords && c.name.toLowerCase().trim() !== name.toLowerCase().trim()) {
            return c;
        }
    }
    return null;
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

    const allowedFields = ["name", "nameAliases", "description", "notes", "source", "dynamicTitle", "narrativeSummary", "folderId", "avatar", "hardLocks", "softLocks", "suppressDescriptionInjection", "suppressNotesInjection"];
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

    if (!Array.isArray(profile.updateLog)) profile.updateLog = [];
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

    if (!Array.isArray(profile.updateLog)) profile.updateLog = [];
    profile.updateLog = profile.updateLog.filter((entry) => entry.sceneId !== sceneId);
    saveCharacter(charId, profile);
}

/**
 * Remove an update log entry by timestamp (for entries without sceneId, e.g. manual edits).
 * @param {string} charId
 * @param {number} timestamp
 */
export function removeUpdateLogEntryByTimestamp(charId, timestamp) {
    const profile = getStoredCharacter(charId);
    if (!profile || !timestamp) return;

    if (!Array.isArray(profile.updateLog)) profile.updateLog = [];
    profile.updateLog = profile.updateLog.filter((entry) => entry.timestamp !== timestamp);
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

// ─── Folder Operations ────────────────────────────────────

/**
 * Generate a unique folder ID.
 * @returns {string}
 */
function generateFolderId() {
    return "folder_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
}

/**
 * Create a new folder.
 * @param {string} name - Folder display name
 * @returns {object} The new folder
 */
export function createFolder(name) {
    const folders = getFolders();
    const folder = {
        id: generateFolderId(),
        name: name.trim(),
        timestamp: Date.now(),
    };
    folders.push(folder);
    saveFolders(folders);
    return folder;
}

/**
 * Rename a folder.
 * @param {string} folderId
 * @param {string} newName
 */
export function renameFolder(folderId, newName) {
    const folders = getFolders();
    const folder = folders.find((f) => f.id === folderId);
    if (folder) {
        folder.name = newName.trim();
        folder.timestamp = Date.now();
        saveFolders(folders);
    }
}

/**
 * Delete a folder. Characters inside are ejected to unfiled (folderId = null).
 * This NEVER deletes character data — only clears the folderId field.
 * @param {string} folderId
 * @returns {number} Number of characters ejected
 */
export function deleteFolderAndEject(folderId) {
    // Remove the folder from the list
    const folders = getFolders();
    const idx = folders.findIndex((f) => f.id === folderId);
    if (idx === -1) return 0;
    folders.splice(idx, 1);
    saveFolders(folders);

    // Eject all characters in this folder to unfiled
    let ejected = 0;
    const all = getAllCharacters();
    for (const char of all) {
        if (char.folderId === folderId) {
            updateCharacterProfile(char.id, { folderId: null });
            ejected++;
        }
    }

    return ejected;
}

/**
 * Move a character to a folder (or unfiled if folderId is null).
 * @param {string} charId
 * @param {string|null} folderId - Folder ID, or null to unfile
 */
export function moveCharToFolder(charId, folderId) {
    updateCharacterProfile(charId, { folderId });
}

/**
 * Get characters in a specific folder.
 * @param {string} folderId
 * @returns {Array<object>}
 */
export function getCharactersInFolder(folderId) {
    const all = getAllCharacters();
    return all.filter((c) => c.folderId === folderId);
}

/**
 * Get all unfiled characters (no folder assigned).
 * @returns {Array<object>}
 */
export function getUnfiledCharacters() {
    const all = getAllCharacters();
    return all.filter((c) => !c.folderId);
}

/**
 * Get the most recent timestamp from a character's update log.
 * Used for "Recently updated" sort.
 * @param {object} profile
 * @returns {number} Timestamp or 0 if no updates
 */
export function getMostRecentTimestamp(profile) {
    if (!profile.updateLog || profile.updateLog.length === 0) return 0;
    let max = 0;
    for (const entry of profile.updateLog) {
        if (entry.timestamp && entry.timestamp > max) {
            max = entry.timestamp;
        }
    }
    return max;
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
 * Validate a single character profile against the expected schema.
 * Returns an array of error messages (empty = valid).
 * @param {object} profile
 * @returns {string[]}
 */
function validateProfile(profile) {
    const errors = [];

    // Required: id must be a non-empty string
    if (typeof profile.id !== "string" || !profile.id.trim()) {
        errors.push("Missing or invalid 'id' (must be a non-empty string)");
    }

    // Required: name must be a non-empty string
    if (typeof profile.name !== "string" || !profile.name.trim()) {
        errors.push("Missing or invalid 'name' (must be a non-empty string)");
    }

    // Required: stats must be an object with all categories and numeric stat values
    if (!profile.stats || typeof profile.stats !== "object") {
        errors.push("Missing or invalid 'stats' (must be an object)");
    } else {
        for (const cat of STAT_CATEGORIES) {
            if (!profile.stats[cat] || typeof profile.stats[cat] !== "object") {
                errors.push(`Missing or invalid stats category: "${cat}"`);
            } else {
                for (const stat of STAT_NAMES) {
                    const val = profile.stats[cat][stat];
                    if (typeof val !== "number" || isNaN(val)) {
                        errors.push(`Invalid stat value for "${cat}/${stat}" (must be a number, got ${typeof val})`);
                    }
                }
            }
        }
    }

    // updateLog should be an array; tolerate a legacy profile that predates it
    // (treat absent as empty rather than rejecting valid old data on import).
    if (profile.updateLog !== undefined && !Array.isArray(profile.updateLog)) {
        errors.push("Invalid 'updateLog' (must be an array if present)");
    }

    // Optional fields: type checks
    if (profile.description !== undefined && typeof profile.description !== "string") {
        errors.push("Invalid type for 'description' (must be a string)");
    }
    if (profile.notes !== undefined && typeof profile.notes !== "string") {
        errors.push("Invalid type for 'notes' (must be a string)");
    }
    if (profile.dynamicTitle !== undefined && typeof profile.dynamicTitle !== "string") {
        errors.push("Invalid type for 'dynamicTitle' (must be a string)");
    }
    if (profile.narrativeSummary !== undefined && typeof profile.narrativeSummary !== "string") {
        errors.push("Invalid type for 'narrativeSummary' (must be a string)");
    }
    if (profile.source !== undefined && typeof profile.source !== "string") {
        errors.push("Invalid type for 'source' (must be a string)");
    }
    // folderId and avatar are optional and passed through without validation

    return errors;
}

/**
 * Import character data from a JSON string.
 * Validates each profile against the expected schema before importing.
 * Skips invalid entries and reports errors.
 * @param {string} jsonString
 * @returns {{ count: number, errors: string[] }} Number imported + validation errors
 */
export function importCharacters(jsonString) {
    try {
        const imported = JSON.parse(jsonString);
        if (typeof imported !== "object" || imported === null) {
            return { count: -1, errors: ["Invalid character data: expected a JSON object"] };
        }

        const existing = getCharacters();
        let count = 0;
        const errors = [];

        for (const [id, profile] of Object.entries(imported)) {
            if (!profile || typeof profile !== "object") {
                errors.push(`Entry "${id}": not a valid object, skipped`);
                continue;
            }

            // Validate schema
            const validationErrors = validateProfile(profile);
            if (validationErrors.length > 0) {
                errors.push(`Entry "${profile.name || id}": ${validationErrors.join("; ")}`);
                continue;
            }

            // Check for name collisions
            const similar = findCharacterBySimilarName(profile.name);
            if (similar && similar.id !== id) {
                errors.push(`Entry "${profile.name}": name collision with existing character "${similar.name}" (id=${similar.id}) — skipped to avoid duplicate`);
                continue;
            }

            existing[id] = profile;
            count++;
        }

        if (count > 0) {
            saveAllCharacters(existing);
        }

        return { count, errors };
    } catch (err) {
        console.error("[RST] Failed to import characters:", err);
        return { count: -1, errors: [err.message || "JSON parse failed"] };
    }
}

// ─── Helpers ──────────────────────────────────────────────

/**
 * Clamp all stat values to [-100, 100].
 * @param {object} stats
 * @returns {object} Clamped stats
 */
function clampAllStats(stats) {
    if (stats === null || stats === undefined) {
        console.error("[RST-DEBUG] clampAllStats called with null/undefined stats! Stack:", new Error().stack);
        // Return blank stats as safety net
        return createBlankStats();
    }
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
