/**
 * storage.js — ST storage API wrapper
 * Handles extension_settings.rst and chat_metadata.rst
 */

import { chat_metadata, saveSettingsDebounced, saveChatDebounced } from "../../../../../script.js";
import { extension_settings } from "../../../../../scripts/extensions.js";
import { getContext } from "../../../../extensions.js";

const NAMESPACE = "rst";

function stripEvidenceFields(obj, keys) {
    if (!obj || typeof obj !== "object") return false;
    let changed = false;
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            delete obj[key];
            changed = true;
        }
    }
    return changed;
}

function scrubLegacyRelationshipEvidence(data) {
    if (!data || typeof data !== "object") return false;
    let changed = false;
    const characters = data.characters && typeof data.characters === "object" ? data.characters : {};
    for (const profile of Object.values(characters)) {
        if (!profile || typeof profile !== "object") continue;
        for (const milestone of (Array.isArray(profile.relationshipMilestones) ? profile.relationshipMilestones : [])) {
            changed = stripEvidenceFields(milestone, ["evidenceRefs", "messageRange", "evidencePreview", "candidateIds"]) || changed;
        }
        for (const condition of (Array.isArray(profile.relationshipConditions) ? profile.relationshipConditions : [])) {
            changed = stripEvidenceFields(condition, ["evidenceRefs"]) || changed;
        }
        for (const entry of (Array.isArray(profile.updateLog) ? profile.updateLog : [])) {
            changed = stripEvidenceFields(entry, ["evidenceRefs"]) || changed;
        }
    }

    const pending = data.pendingUpdates;
    for (const update of (Array.isArray(pending?.characterUpdates) ? pending.characterUpdates : [])) {
        changed = stripEvidenceFields(update, ["evidenceRefs"]) || changed;
        for (const item of (Array.isArray(update.proposedMilestones) ? update.proposedMilestones : [])) {
            changed = stripEvidenceFields(item, ["evidence"]) || changed;
        }
        for (const item of (Array.isArray(update.proposedConditions) ? update.proposedConditions : [])) {
            changed = stripEvidenceFields(item, ["evidence"]) || changed;
        }
        for (const item of (Array.isArray(update.resolvedConditions) ? update.resolvedConditions : [])) {
            changed = stripEvidenceFields(item, ["evidence"]) || changed;
        }
    }

    for (const result of (Array.isArray(data.pendingMilestoneScan) ? data.pendingMilestoneScan : [])) {
        for (const milestone of (Array.isArray(result?.milestones) ? result.milestones : [])) {
            changed = stripEvidenceFields(milestone, ["evidenceRefs", "messageRange", "evidencePreview", "candidateIds"]) || changed;
        }
    }
    return changed;
}

function scrubPendingLockEvidence(results) {
    if (!Array.isArray(results)) return false;
    let changed = false;
    for (const result of results) {
        for (const lock of [
            ...(Array.isArray(result?.hardLocks) ? result.hardLocks : []),
            ...(Array.isArray(result?.softLocks) ? result.softLocks : []),
        ]) {
            changed = stripEvidenceFields(lock, ["evidenceRefs", "evidence"]) || changed;
        }
    }
    return changed;
}


// ─── Name blacklist helpers ───────────────────────────────

/**
 * Normalize names for blacklist matching without destroying the display text.
 * Handles case, Unicode width, dash variants, stray punctuation, and whitespace.
 * @param {string} name
 * @returns {string}
 */
export function normalizeNameForMatch(name) {
    return String(name || "")
        .normalize("NFKC")
        .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, "-")
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^[\s"'`*_.,;:!?()[\]{}<>]+|[\s"'`*_.,;:!?()[\]{}<>]+$/g, "")
        .toLowerCase();
}

/**
 * Matching keys used for blacklist comparison. The compact key lets
 * "Vane-san" match "Vane san" without enabling broad substring checks.
 * @param {string} name
 * @returns {string[]}
 */
export function getNameMatchKeys(name) {
    const normalized = normalizeNameForMatch(name);
    if (!normalized) return [];
    const compact = normalized.replace(/[\s._'`-]+/g, "");
    return [...new Set([normalized, compact].filter(Boolean))];
}

/**
 * Parse comma/newline separated blacklist text.
 * @param {string|string[]} value
 * @returns {string[]}
 */
export function parseNameBlacklist(value) {
    if (Array.isArray(value)) {
        return value.map((s) => String(s || "").trim()).filter(Boolean);
    }
    return String(value || "")
        .split(/[,\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);
}

function nameKeysSet(names) {
    const keys = new Set();
    for (const name of names || []) {
        for (const key of getNameMatchKeys(name)) keys.add(key);
    }
    return keys;
}

/**
 * Check whether a name is excluded by the per-chat blacklist or optional extras.
 * @param {string} name
 * @param {string[]} [extraNames]
 * @returns {boolean}
 */
export function isNameBlacklisted(name, extraNames = []) {
    const candidateKeys = getNameMatchKeys(name);
    if (candidateKeys.length === 0) return true;
    const blacklistKeys = nameKeysSet([...(getNameBlacklist() || []), ...(extraNames || [])]);
    return candidateKeys.some((key) => blacklistKeys.has(key));
}

/**
 * Persist chat metadata immediately when ST exposes an immediate save API;
 * otherwise fall back to SillyTavern's debounced chat save.
 */
export async function persistChatNow() {
    try {
        saveChatDebounced();
        if (typeof saveChatDebounced.flush === "function") {
            await Promise.resolve(saveChatDebounced.flush());
        }

        const context = getContext?.();
        if (typeof context?.saveMetadata === "function") {
            await Promise.resolve(context.saveMetadata());
        } else if (typeof context?.saveChat === "function") {
            await Promise.resolve(context.saveChat());
        }
        return true;
    } catch (err) {
        console.warn("[RST] Immediate chat metadata save failed; debounced save is still queued.", err);
        return false;
    }
}

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
    if (scrubPendingLockEvidence(extension_settings[NAMESPACE].pendingLockScan)) {
        saveSettingsDebounced();
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
    if (!chat_metadata[NAMESPACE].characters || typeof chat_metadata[NAMESPACE].characters !== "object" || Array.isArray(chat_metadata[NAMESPACE].characters)) {
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
    chat_metadata[NAMESPACE].characters = (characters && typeof characters === "object" && !Array.isArray(characters)) ? characters : {};
    saveChatDebounced();
}

// ─── Folders (Per-Chat) ───────────────────────────────────

/**
 * Get all folders for the current chat.
 * @returns {Array<{id: string, name: string, timestamp: number}>}
 */
export function getFolders() {
    ensureChatNamespace();
    if (!Array.isArray(chat_metadata[NAMESPACE].folders)) {
        chat_metadata[NAMESPACE].folders = [];
    }
    return chat_metadata[NAMESPACE].folders;
}

/**
 * Save the folders array.
 * @param {Array<{id: string, name: string, timestamp: number}>} folders
 */
export function saveFolders(folders) {
    ensureChatNamespace();
    chat_metadata[NAMESPACE].folders = folders;
    saveChatDebounced();
}

// ─── Per-Chat Data ────────────────────────────────────────

/**
 * Ensure the RST namespace exists in chat_metadata.
 */
function ensureChatNamespace() {
    if (!chat_metadata[NAMESPACE] || typeof chat_metadata[NAMESPACE] !== "object" || Array.isArray(chat_metadata[NAMESPACE])) {
        chat_metadata[NAMESPACE] = {};
    }

    // Defensive migration/backfill. Old chats/imports may have a partial rst
    // namespace, and a missing scenes array can crash boot before the UI mounts.
    const data = chat_metadata[NAMESPACE];
    if (!Array.isArray(data.scenes)) data.scenes = [];
    if (data.pendingUpdates === undefined) data.pendingUpdates = null;
    if (data.pendingMilestoneScan === undefined) data.pendingMilestoneScan = null;
    if (!Array.isArray(data.presentCharacters)) data.presentCharacters = [];
    if (!data.presenceModes || typeof data.presenceModes !== "object" || Array.isArray(data.presenceModes)) data.presenceModes = {};
    if (typeof data.messageCounter !== "number") data.messageCounter = 0;
    if (!data.characters || typeof data.characters !== "object" || Array.isArray(data.characters)) data.characters = {};
    if (!Array.isArray(data.folders)) data.folders = [];
    if (!Array.isArray(data.nameBlacklist)) data.nameBlacklist = [];
    if (scrubLegacyRelationshipEvidence(data)) {
        saveChatDebounced();
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
    if (!Array.isArray(chat_metadata[NAMESPACE].scenes)) {
        chat_metadata[NAMESPACE].scenes = [];
        saveChatDebounced();
    }
    return chat_metadata[NAMESPACE].scenes;
}

/**
 * Save the scenes array.
 * @param {Array} scenes
 */
export function saveScenes(scenes) {
    ensureChatNamespace();
    chat_metadata[NAMESPACE].scenes = Array.isArray(scenes) ? scenes : [];
    saveChatDebounced();
}

/**
 * Get pending updates for this chat.
 * @returns {object|null}
 */
export function getPendingUpdates() {
    ensureChatNamespace();
    return chat_metadata[NAMESPACE].pendingUpdates || null;
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
 * Pending retroactive milestone scan for the current chat. Kept per-chat so a
 * review from one roleplay can never leak into another.
 * @returns {Array|null}
 */
export function getPendingMilestoneScan() {
    ensureChatNamespace();
    return chat_metadata[NAMESPACE].pendingMilestoneScan || null;
}

/**
 * Save or clear the current chat's pending milestone backfill results.
 * @param {Array|null} results
 */
export function savePendingMilestoneScan(results) {
    ensureChatNamespace();
    chat_metadata[NAMESPACE].pendingMilestoneScan = results || null;
    saveChatDebounced();
}

/**
 * Pending lock-scan results (library-wide, so stored globally in
 * extension_settings rather than per-chat). Persisted so that dismissing the
 * review dialog does not throw away an expensive scan — it can be reopened.
 * @returns {Array|null}
 */
export function getPendingLockScan() {
    if (!extension_settings[NAMESPACE]) return null;
    const pending = extension_settings[NAMESPACE].pendingLockScan || null;
    if (scrubPendingLockEvidence(pending)) saveSettingsDebounced();
    return pending;
}

/**
 * Save (or clear, with null) the pending lock-scan results.
 * @param {Array|null} results
 */
export function savePendingLockScan(results) {
    if (!extension_settings[NAMESPACE]) {
        extension_settings[NAMESPACE] = {};
    }
    extension_settings[NAMESPACE].pendingLockScan = results || null;
    saveSettingsDebounced();
}

/**
 * Get present characters for this chat.
 * @returns {Array<string>} Array of character IDs
 */
export function getPresentCharacters() {
    ensureChatNamespace();
    if (!Array.isArray(chat_metadata[NAMESPACE].presentCharacters)) {
        chat_metadata[NAMESPACE].presentCharacters = [];
        saveChatDebounced();
    }
    return chat_metadata[NAMESPACE].presentCharacters;
}

/**
 * Save present characters list.
 * @param {Array<string>} charIds
 */
export function savePresentCharacters(charIds) {
    ensureChatNamespace();
    const safeIds = Array.isArray(charIds) ? [...new Set(charIds.filter((id) => typeof id === "string" && id))] : [];
    chat_metadata[NAMESPACE].presentCharacters = safeIds;

    // Keep presence-mode metadata aligned with the active list. Manual additions
    // default to unknown until the sidecar observes physical/remote evidence.
    const previousModes = chat_metadata[NAMESPACE].presenceModes || {};
    const nextModes = {};
    for (const id of safeIds) {
        const mode = String(previousModes[id] || "").toLowerCase();
        nextModes[id] = ["physical", "call", "surveillance", "message", "remote", "parallel"].includes(mode) ? mode : "unknown";
    }
    chat_metadata[NAMESPACE].presenceModes = nextModes;
    saveChatDebounced();
}

/**
 * Get per-character presence modes for the current chat.
 * @returns {Record<string, "physical"|"call"|"surveillance"|"message"|"remote"|"parallel"|"unknown">}
 */
export function getPresenceModes() {
    ensureChatNamespace();
    if (!chat_metadata[NAMESPACE].presenceModes
        || typeof chat_metadata[NAMESPACE].presenceModes !== "object"
        || Array.isArray(chat_metadata[NAMESPACE].presenceModes)) {
        chat_metadata[NAMESPACE].presenceModes = {};
        saveChatDebounced();
    }
    return chat_metadata[NAMESPACE].presenceModes;
}

/**
 * Save per-character presence modes, pruned to currently present character IDs.
 * @param {Record<string, string>} modes
 */
export function savePresenceModes(modes) {
    ensureChatNamespace();
    const presentIds = new Set(getPresentCharacters());
    const next = {};
    for (const [id, rawMode] of Object.entries(modes || {})) {
        if (!presentIds.has(id)) continue;
        const mode = String(rawMode || "").toLowerCase();
        next[id] = ["physical", "call", "surveillance", "message", "remote", "parallel"].includes(mode) ? mode : "unknown";
    }
    for (const id of presentIds) {
        if (!(id in next)) next[id] = "unknown";
    }
    chat_metadata[NAMESPACE].presenceModes = next;
    saveChatDebounced();
}

/**
 * Get the per-chat name blacklist.
 * @returns {Array<string>}
 */
export function getNameBlacklist() {
    ensureChatNamespace();
    if (!Array.isArray(chat_metadata[NAMESPACE].nameBlacklist)) {
        chat_metadata[NAMESPACE].nameBlacklist = [];
        saveChatDebounced();
    }
    return chat_metadata[NAMESPACE].nameBlacklist;
}

/**
 * Save the per-chat name blacklist.
 * @param {Array<string>} names
 */
export function saveNameBlacklist(names, immediate = false) {
    ensureChatNamespace();

    // Preserve display text, but dedupe by normalized match keys so variants like
    // "Vane-san" and "Vane san" don't need to be re-added forever.
    const cleaned = parseNameBlacklist(names);
    const seen = new Set();
    const deduped = [];
    for (const name of cleaned) {
        const keys = getNameMatchKeys(name);
        if (keys.length === 0) continue;
        if (keys.some((key) => seen.has(key))) continue;
        for (const key of keys) seen.add(key);
        deduped.push(name);
    }

    chat_metadata[NAMESPACE].nameBlacklist = deduped;
    if (immediate) {
        return persistChatNow();
    }
    saveChatDebounced();
    return true;
}

/**
 * Add one or more names to the per-chat blacklist without duplicating variants.
 * @param {string|string[]} names
 * @param {boolean} [immediate]
 * @returns {boolean} true if the blacklist changed
 */
export function addNamesToBlacklist(names, immediate = false) {
    ensureChatNamespace();
    const current = getNameBlacklist();
    const currentKeys = nameKeysSet(current);
    let changed = false;

    for (const name of parseNameBlacklist(names)) {
        const keys = getNameMatchKeys(name);
        if (keys.length === 0) continue;
        if (keys.some((key) => currentKeys.has(key))) continue;
        current.push(name);
        for (const key of keys) currentKeys.add(key);
        changed = true;
    }

    if (changed) {
        saveNameBlacklist(current, immediate);
    }
    return changed;
}

/**
 * Get the message counter for sidecar scan frequency.
 * @returns {number}
 */
export function getMessageCounter() {
    ensureChatNamespace();
    return typeof chat_metadata[NAMESPACE].messageCounter === "number" ? chat_metadata[NAMESPACE].messageCounter : 0;
}

/**
 * Set and save the message counter.
 *
 * Historically this value was a simple ever-incrementing sidecar counter. It is
 * now treated as the live chat message count at the last sidecar scan/baseline.
 * Keeping the same field name preserves old chat metadata while allowing the
 * scheduler to recover when messages are deleted and SillyTavern renumbers the chat.
 *
 * @param {number} value
 * @returns {number} Saved counter value
 */
export function setMessageCounter(value) {
    ensureChatNamespace();
    const parsed = Number(value);
    const safeValue = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
    chat_metadata[NAMESPACE].messageCounter = safeValue;
    saveChatDebounced();
    return chat_metadata[NAMESPACE].messageCounter;
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
 * Clamp the sidecar message counter to the current live chat size.
 *
 * This prevents deleted messages from stranding the sidecar scheduler in the
 * future. Example: a chat grows to message 170, then OOC messages are deleted
 * and the visible/live chat returns to 143. The saved counter must not remain
 * at 170, or the sidecar will act like it has already processed messages that
 * no longer exist.
 *
 * @param {number} liveMessageCount Current live chat.length / mesId + 1
 * @returns {{counter:number, previous:number, changed:boolean}}
 */
export function syncMessageCounterToLiveCount(liveMessageCount) {
    ensureChatNamespace();
    const parsed = Number(liveMessageCount);
    const live = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
    const previous = typeof chat_metadata[NAMESPACE].messageCounter === "number"
        ? chat_metadata[NAMESPACE].messageCounter
        : 0;

    if (previous > live) {
        chat_metadata[NAMESPACE].messageCounter = live;
        saveChatDebounced();
        return { counter: live, previous, changed: true };
    }

    return { counter: previous, previous, changed: false };
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

        // Debug F12 logging: when true, routine [RST] activity logs appear in the
        // browser console. Warnings and errors always show regardless. Off by default.
        debug: false,

        // No-think soft switch: append "/no_think" to each LLM call to disable
        // reasoning on supporting models (Qwen3, etc.). Harmless to others.
        noThink: false,
        // No-think hard switch: also send API params (think/enable_thinking=false).
        // Off by default — some backends error on unknown body keys.
        noThinkHard: false,
        // Per-profile no-think, keyed by connection profile ID. Take precedence
        // over the blanket booleans above when present.
        noThinkProfiles: {},
        noThinkHardProfiles: {},

        connections: {
            statUpdateLLM: "",
            sidecarLLM: "",
            autoGenLLM: "",
        },

        messagesToScan: 10,
        scanFrequency: 5,
        sidecarPaused: false,
        newCharPopup: true,
        statChangeRange: { min: -5, max: 5 },
        criticalChanges: {
            enabled: true,
            chance: 15,       // % chance an LLM-flagged stat actually goes critical (default; existing saved values are preserved)
            multiplier: 3,    // critical changes get this x the normal range ceiling
        },
        hardLocks: {
            enabled: true,   // enforce per-stat hard caps; criticals can raise them
        },
        softLocks: {
            enabled: true,   // enforce conditional caps that auto-unlock when met
            maxActive: 1,    // max simultaneous active soft locks per character (1-3); a CEILING, not a target
        },
        sceneSummaryPrompt:
            "Write a concise scene summary for internal reference. Include: key events, emotional turning points, characters present, and any significant relationship shifts. Keep it clinical and factual — this is a note for future analysis, not a narrative retelling.",

        batchScan: {
            sceneDetectionMaxTokens: 4000,
            initialStatMaxTokens: 3000,
            requestsPerMinute: 10,
            maxRetries: 3,
            baseRetryDelay: 1000,
            perSceneDelay: 0,
            interPhaseDelay: 0,
            combineRanges: true,
        },

        injection: {
            injectStats: true,
            injectProfile: true,
            format: "stats_and_narrative",
            placement: "above_card",
            passiveLibraryRef: false,
            statToolEnabled: true,
            libraryRefDepth: 2,
            libraryRefRole: "system",
        },
    };
}
