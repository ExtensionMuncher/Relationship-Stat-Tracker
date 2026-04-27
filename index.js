/**
 * index.js — Extension entry point
 * Registers the RST extension with SillyTavern, initializes UI, and binds events
 */

import {
    eventSource,
    event_types,
    chat,
    chat_metadata,
    saveSettingsDebounced,
    saveChatDebounced,
    extension_settings,
} from "../../../../../script.js";

import { initSettings, isEnabled, getSetting } from "./settings.js";
import { getSettings, getPresentCharacters, savePresentCharacters, getMessageCounter, incrementMessageCounter } from "./data/storage.js";
import { createCharacter, findCharacterByName } from "./data/characters.js";
import { createScene, closeScene, getOpenScene, initSceneCounter, getAllScenes } from "./data/scenes.js";
import { detectCharacters } from "./llm/sidecar.js";
import { generateStatUpdate } from "./llm/statUpdate.js";
import { updateInjection, removeInjection } from "./inject/promptInjector.js";
import { createPanel, renderHomeHeader, getPane, switchTab } from "./ui/panel.js";
import { renderHomeTab } from "./ui/home.js";
import { renderLibraryTab, selectCharacter, showNewCharacterDetected } from "./ui/library.js";
import { renderScenesTab } from "./ui/scenes.js";
import { renderSettingsTab } from "./ui/settings.js";

// ─── Extension Constants ──────────────────────────────────

const EXTENSION_NAME = "rst";

// ─── jQuery Extension init ────────────────────────────────

/**
 * Main entry point — called by SillyTavern when the extension loads.
 */
jQuery(async () => {
    console.log("[RST] Relationship State Tracker loading...");

    try {
        // 1. Initialize settings
        await initSettings();

        // 2. Initialize scene counter
        initSceneCounter();

        // 3. Create the UI panel
        const $panel = createPanel();

        // 4. Render the Home tab header
        const $homePane = getPane("home");
        renderHomeHeader($homePane);

        // 5. Render all tab content
        renderHomeTab($homePane);
        renderLibraryTab(getPane("lib"));
        renderScenesTab(getPane("scenes"));
        renderSettingsTab(getPane("settings"));

        // 6. Register event handlers
        registerEventHandlers();

        // 7. Register slash commands
        registerSlashCommands();

        // 8. Initial injection update
        if (isEnabled()) {
            updateInjection();
        }

        // 9. Listen for tab switches to refresh content
        $(document).on("rst:tab-switched", (_e, tabId) => {
            const $pane = getPane(tabId);
            switch (tabId) {
                case "home":
                    renderHomeTab($pane);
                    renderHomeHeader($pane);
                    break;
                case "lib":
                    renderLibraryTab($pane);
                    break;
                case "scenes":
                    renderScenesTab($pane);
                    break;
                case "settings":
                    renderSettingsTab($pane);
                    break;
            }
        });

        // 10. Listen for character selection from Home tab
        $(document).on("rst:select-character", (_e, charId) => {
            selectCharacter(charId);
        });

        // 11. Listen for toggle
        $(document).on("rst:toggle", (_e, enabled) => {
            if (enabled) {
                updateInjection();
            } else {
                removeInjection();
            }
        });

        console.log("[RST] Relationship State Tracker loaded successfully.");
    } catch (err) {
        console.error("[RST] Failed to load:", err);
    }
});

// ─── Event Handlers ───────────────────────────────────────

/**
 * Register all SillyTavern event handlers.
 */
function registerEventHandlers() {
    // Character message rendered — add scene buttons + sidecar check
    eventSource.on(event_types.MESSAGE_RECEIVED, (mesId) => {
        onMessageReceived(mesId);
    });

    // User message rendered — add scene buttons + sidecar check
    eventSource.on(event_types.MESSAGE_SENT, (mesId) => {
        onMessageReceived(mesId);
    });

    // Chat changed — re-render everything
    eventSource.on(event_types.CHAT_CHANGED, () => {
        onChatChanged();
    });
}

/**
 * Handle a new message (sent or received).
 * - Add Scene Start/End buttons to the message bar
 * - Run sidecar detection if scan frequency is met
 * @param {number} mesId
 */
async function onMessageReceived(mesId) {
    if (!isEnabled()) return;

    // Add scene buttons to message bar
    addSceneButtons(mesId);

    // Sidecar detection check
    const settings = getSettings();
    const counter = incrementMessageCounter();
    const frequency = settings.scanFrequency || 5;

    if (counter % frequency === 0) {
        try {
            const result = await detectCharacters();

            // Update present characters
            const allDetected = [...result.detected, ...result.unknown.map((name) => {
                // Find or create character for unknown names
                const existing = findCharacterByName(name);
                return existing ? existing.id : null;
            })].filter(Boolean);

            // Handle unknown characters
            for (const unknownName of result.unknown) {
                const existing = findCharacterByName(unknownName);
                if (!existing && settings.newCharPopup) {
                    showNewCharacterDetected(unknownName);
                }
            }

            // Update present characters list
            if (allDetected.length > 0) {
                savePresentCharacters(allDetected);
            }

            // Update injection
            updateInjection();

            // Refresh Home tab if visible
            const $homePane = getPane("home");
            if ($homePane.hasClass("on")) {
                renderHomeTab($homePane);
                renderHomeHeader($homePane);
            }
        } catch (err) {
            console.error("[RST] Sidecar detection error:", err);
        }
    }
}

/**
 * Handle chat change — re-initialize everything.
 */
function onChatChanged() {
    initSceneCounter();

    // Re-render all tabs
    const $homePane = getPane("home");
    renderHomeHeader($homePane);
    renderHomeTab($homePane);
    renderLibraryTab(getPane("lib"));
    renderScenesTab(getPane("scenes"));

    // Update injection
    if (isEnabled()) {
        updateInjection();
    }
}

// ─── Scene Buttons ────────────────────────────────────────

/**
 * Add Scene Start/End buttons to a message's action bar.
 * @param {number} mesId
 */
function addSceneButtons(mesId) {
    const $messageBar = $(`.mes[mesid="${mesId}"] .extraMesButtons`);
    if ($messageBar.length === 0) return;

    // Don't add duplicates
    if ($messageBar.find(".rst-scene-btn").length > 0) return;

    const openScene = getOpenScene();

    // Scene Start button
    const $startBtn = $(`
        <div class="rst-scene-btn rst-scene-start" title="Start new scene">
            <i class="fa-solid fa-play"></i>
        </div>
    `);

    // Scene End button
    const $endBtn = $(`
        <div class="rst-scene-btn rst-scene-end" title="End current scene">
            <i class="fa-solid fa-stop"></i>
        </div>
    `);

    // If there's an open scene, highlight the start button
    if (openScene) {
        $startBtn.addClass("rst-scene-active");
    }

    $startBtn.on("click", async () => {
        if (getOpenScene()) {
            toastr?.warning?.("A scene is already open. Close it first.");
            return;
        }
        createScene(mesId);
        toastr?.success?.(`Scene started at message ${mesId}.`);
        $startBtn.addClass("rst-scene-active");

        // Refresh scenes tab
        renderScenesTab(getPane("scenes"));
    });

    $endBtn.on("click", async () => {
        const openScene = getOpenScene();
        if (!openScene) {
            toastr?.warning?.("No open scene to close.");
            return;
        }

        // Close the scene
        const closedScene = closeScene(openScene.id, mesId);
        if (!closedScene) return;

        toastr?.info?.("Scene closed. Generating stat updates...");

        // Trigger stat update flow
        try {
            const result = await generateStatUpdate(closedScene.id);

            // Store the scene summary
            const { updateSceneSummary } = await import("./data/scenes.js");
            updateSceneSummary(closedScene.id, result.sceneSummary);

            // Store pending updates
            const { savePendingUpdates } = await import("./data/storage.js");
            savePendingUpdates(result);

            toastr?.success?.("Stat updates ready for review! Check the Home tab.");

            // Refresh UI
            const $homePane = getPane("home");
            renderHomeTab($homePane);
            renderHomeHeader($homePane);
            renderScenesTab(getPane("scenes"));
        } catch (err) {
            console.error("[RST] Stat update failed after scene close:", err);
            toastr?.error?.("Stat update generation failed. Please try again from the Home tab.");
        }

        $startBtn.removeClass("rst-scene-active");
    });

    $messageBar.prepend($endBtn);
    $messageBar.prepend($startBtn);
}

// ─── Slash Commands ───────────────────────────────────────

/**
 * Register slash commands for RST.
 */
function registerSlashCommands() {
    // These would use ST's SlashCommandParser if available
    // For now, we'll add them as a TODO since the exact API depends on ST version
    console.log("[RST] Slash commands registered (placeholder)");
}
