/**
 * scenes.js — Scene open/close + summary storage
 * Scenes are stored per-chat in chat_metadata.rst.scenes
 */

import { getScenes, saveScenes, getPresentCharacters } from "./storage.js";

// ─── Scene Counter ────────────────────────────────────────

let sceneCounter = 0;

/**
 * Initialize the scene counter based on existing scenes.
 */
export function initSceneCounter() {
    const scenes = getScenes();
    if (scenes.length === 0) {
        sceneCounter = 0;
        return;
    }
    // Find the highest scene number
    let maxNum = 0;
    for (const scene of scenes) {
        const match = scene.id.match(/scene_(\d+)/);
        if (match) {
            maxNum = Math.max(maxNum, parseInt(match[1], 10));
        }
    }
    sceneCounter = maxNum;
}

// ─── Create / Open ────────────────────────────────────────

/**
 * Create a new open scene starting at the given message index.
 * @param {number} messageStart - The mesId where the scene begins
 * @returns {object} The new scene entry
 */
export function createScene(messageStart) {
    sceneCounter++;
    const scene = {
        id: `scene_${sceneCounter}`,
        status: "open",
        messageStart,
        messageEnd: null,
        charactersPresent: [...getPresentCharacters()],
        llmSummary: "",
        timestamp: Date.now(),
    };

    const scenes = getScenes();
    scenes.push(scene);
    saveScenes(scenes);
    return scene;
}

// ─── Close ────────────────────────────────────────────────

/**
 * Close an open scene, setting the end message index.
 * @param {string} sceneId
 * @param {number} messageEnd - The mesId where the scene ends
 * @returns {object|null} The updated scene, or null if not found
 */
export function closeScene(sceneId, messageEnd) {
    const scenes = getScenes();
    const scene = scenes.find((s) => s.id === sceneId);
    if (!scene || scene.status !== "open") return null;

    scene.status = "closed";
    scene.messageEnd = messageEnd;
    scene.charactersPresent = [...getPresentCharacters()];
    saveScenes(scenes);
    return scene;
}

// ─── Read Operations ──────────────────────────────────────

/**
 * Get all scenes for this chat.
 * @returns {Array<object>}
 */
export function getAllScenes() {
    return getScenes();
}

/**
 * Get the currently open scene (if any).
 * @returns {object|null}
 */
export function getOpenScene() {
    const scenes = getScenes();
    return scenes.find((s) => s.status === "open") || null;
}

/**
 * Get a scene by ID.
 * @param {string} sceneId
 * @returns {object|null}
 */
export function getSceneById(sceneId) {
    const scenes = getScenes();
    return scenes.find((s) => s.id === sceneId) || null;
}

/**
 * Get all closed scenes.
 * @returns {Array<object>}
 */
export function getClosedScenes() {
    return getScenes().filter((s) => s.status === "closed");
}

/**
 * Get all scene summaries (for injection into LLM prompts).
 * @returns {Array<{id: string, summary: string}>}
 */
export function getAllSceneSummaries() {
    return getScenes()
        .filter((s) => s.status === "closed" && s.llmSummary)
        .map((s) => ({ id: s.id, summary: s.llmSummary }));
}

// ─── Update Operations ────────────────────────────────────

/**
 * Update a scene's LLM summary.
 * @param {string} sceneId
 * @param {string} summary
 */
export function updateSceneSummary(sceneId, summary) {
    const scenes = getScenes();
    const scene = scenes.find((s) => s.id === sceneId);
    if (!scene) return;
    scene.llmSummary = summary;
    saveScenes(scenes);
}

/**
 * Update a scene's characters present list.
 * @param {string} sceneId
 * @param {Array<string>} charIds
 */
export function updateSceneCharacters(sceneId, charIds) {
    const scenes = getScenes();
    const scene = scenes.find((s) => s.id === sceneId);
    if (!scene) return;
    scene.charactersPresent = charIds;
    saveScenes(scenes);
}

// ─── Delete ───────────────────────────────────────────────

/**
 * Delete a scene by ID.
 * @param {string} sceneId
 * @returns {boolean} True if deleted
 */
export function deleteScene(sceneId) {
    const scenes = getScenes();
    const index = scenes.findIndex((s) => s.id === sceneId);
    if (index === -1) return false;
    scenes.splice(index, 1);
    saveScenes(scenes);
    return true;
}

// ─── Helpers ──────────────────────────────────────────────

/**
 * Format a timestamp for display.
 * @param {number} timestamp - Unix timestamp in ms
 * @returns {string} Human-readable relative time
 */
export function formatTimeAgo(timestamp) {
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 30) return `${days}d ago`;
    return new Date(timestamp).toLocaleDateString();
}

/**
 * Check if a message index falls within a scene's range.
 * @param {object} scene
 * @param {number} mesId
 * @returns {boolean}
 */
export function isMessageInScene(scene, mesId) {
    if (scene.messageStart !== null && mesId < scene.messageStart) return false;
    if (scene.messageEnd !== null && mesId > scene.messageEnd) return false;
    return true;
}
