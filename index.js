/**
 * index.js — Extension entry point
 * Registers the RST extension with SillyTavern, initializes UI, and binds events
 */

import {
    chat,
    chat_metadata,
    saveSettingsDebounced,
    saveChatDebounced,
} from "../../../../script.js";

import { eventSource, event_types } from "../../../../scripts/events.js";
import { extension_settings } from "../../../../scripts/extensions.js";

import { initSettings, isEnabled, getSetting } from "./settings.js";
import { getSettings, getPresentCharacters, savePresentCharacters, getMessageCounter, incrementMessageCounter, getPendingUpdates, savePendingUpdates } from "./data/storage.js";
import { createCharacter, findCharacterByName } from "./data/characters.js";
import { createScene, closeScene, getOpenScene, initSceneCounter, getAllScenes, isMessageInScene, updateSceneSummary, updateSceneTitle } from "./data/scenes.js";
import { detectCharacters } from "./llm/sidecar.js";
import { generateStatUpdate } from "./llm/statUpdate.js";
import { updateInjection, removeInjection } from "./inject/promptInjector.js";
import { createPanel, renderHomeHeader, getPane, switchTab, showPanelLoading, hidePanelLoading } from "./ui/panel.js";
import { renderHomeTab } from "./ui/home.js";
import { renderLibraryTab, selectCharacter, showNewCharacterDetected } from "./ui/library.js";
import { renderScenesTab } from "./ui/scenes.js";
import { renderSettingsTab } from "./ui/settings.js";

// ─── Extension Constants ──────────────────────────────────

const EXTENSION_NAME = "rst";

// ─── Re-entrancy guard ───────────────────────────────────
// Prevents overlapping sidecar detection calls that could cause connection profile churn
let _sidecarRunning = false;

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

        // 9. Listen for APP_READY — ST emits this after full initialization,
        //    after all extensions have loaded and messages are rendered.
        //    CHAT_CHANGED may fire before the extension registers its handler,
        //    so we use APP_READY as the reliable trigger to re-add buttons.
        eventSource.once(event_types.APP_READY, () => {
            if (!isEnabled()) return;
            $(".mes").each(function () {
                const mesId = $(this).attr("mesid");
                if (mesId !== undefined) {
                    addSceneButtons(parseInt(mesId, 10));
                }
            });
        });

        // 9. Listen for tab switches to refresh content
        $(document).on("rst:tab-switched", (_e, tabId) => {
            const $pane = getPane(tabId);
            switch (tabId) {
                case "home":
                    renderHomeTab($pane);
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

    // Scenes deleted / chat data changed — re-add scene buttons to all messages
    // ST may re-render messages when chat_metadata is saved, destroying injected buttons.
    // Using a short delay to let any pending async saves complete first.
    $(document).on("rst:refresh-message-buttons", () => {
        setTimeout(() => {
            let added = 0;
            $(".mes").each(function () {
                const mesId = $(this).attr("mesid");
                if (mesId === undefined) return;
                const mesIdNum = parseInt(mesId, 10);
                const $msgBar = $(`.mes[mesid="${mesIdNum}"] .extraMesButtons`);
                if ($msgBar.length === 0) return;
                if ($msgBar.find(".rst-scene-btn").length > 0) return;
                addSceneButtons(mesIdNum);
                added++;
            });
            if (added > 0) console.log(`[RST] Added scene buttons to ${added} message(s)`);
        }, 300);
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
        // Re-entrancy guard — skip if a sidecar detection is already in progress
        if (_sidecarRunning) {
            console.warn("[RST] Sidecar detection already in progress, skipping duplicate call (counter=" + counter + ")");
            return;
        }

        _sidecarRunning = true;
        const profileName = settings.connections?.sidecarLLM || "(none)";
        console.log("[RST] Sidecar detection start (counter=" + counter + ", frequency=" + frequency + ", profile=" + profileName + ")");

        try {
            const result = await detectCharacters();

            console.log("[RST] Sidecar detection result — detected:", result.detected.length, "unknown:", result.unknown.length);

            // Filter out {{user}} from detected and unknown names
            const EXCLUDED_NAMES = new Set(["{{user}}", "user", "User"]);
            const filteredDetected = result.detected.filter((name) => !EXCLUDED_NAMES.has(name));
            const filteredUnknown = result.unknown.filter((name) => !EXCLUDED_NAMES.has(name));

            // Build detected character IDs
            const newDetected = [...filteredDetected, ...filteredUnknown.map((name) => {
                const existing = findCharacterByName(name);
                return existing ? existing.id : null;
            })].filter(Boolean);

            // Handle unknown characters
            for (const unknownName of filteredUnknown) {
                const existing = findCharacterByName(unknownName);
                if (!existing && settings.newCharPopup) {
                    showNewCharacterDetected(unknownName);
                }
            }

            // Only update present characters + injection if the list actually changed
            const currentPresent = getPresentCharacters();
            const changed = newDetected.length !== currentPresent.length ||
                !newDetected.every((id) => currentPresent.includes(id));

            if (changed) {
                console.log("[RST] Present characters changed — old:", currentPresent.length, "new:", newDetected.length, ". Updating.");
                if (newDetected.length > 0) {
                    savePresentCharacters(newDetected);
                }
                updateInjection();
            } else {
                console.log("[RST] Present characters unchanged — skipping injection update.");
            }

            // Refresh Home tab if visible
            const $homePane = getPane("home");
            if ($homePane.hasClass("on")) {
                renderHomeTab($homePane);
            }
        } catch (err) {
            console.error("[RST] Sidecar detection error:", err);
        } finally {
            _sidecarRunning = false;
            console.log("[RST] Sidecar detection complete");
        }
    }
}

/**
 * Handle chat change — re-initialize everything.
 * Warns if there are pending updates from the previous chat.
 */
function onChatChanged() {
    // Warn about pending updates in the previous chat
    // (pending updates are stored per-chat and persist across switches)
    const pending = getPendingUpdates();
    if (pending) {
        const pendingScenes = Object.keys(pending);
        if (pendingScenes.length > 0) {
            let totalUpdates = 0;
            for (const sceneId of pendingScenes) {
                const scene = pending[sceneId];
                if (scene.summary) totalUpdates++;
                if (scene.characters) totalUpdates += Object.keys(scene.characters).length;
            }
            console.log(`[RST] Chat switched with ${totalUpdates} pending update(s) across ${pendingScenes.length} scene(s).`);
            toastr?.warning?.(
                `This chat has ${totalUpdates} unapproved stat update(s) in ${pendingScenes.length} scene(s). Switch to the Home tab to review them.`,
                "Pending Updates",
                { timeOut: 8000 }
            );
        }
    }

    initSceneCounter();

    // Migrate any old global characters to per-chat storage
    // (characters were moved from extension_settings.rst to chat_metadata.rst
    //  in a previous update; this ensures existing user data is not lost)
    migrateGlobalCharacters();

    // Re-render all tabs
    const $homePane = getPane("home");
    renderHomeTab($homePane);
    renderLibraryTab(getPane("lib"));
    renderScenesTab(getPane("scenes"));

    // Update injection
    if (isEnabled()) {
        updateInjection();

        // Re-add scene buttons to all existing messages
        // (buttons are lost when ST re-renders the chat on switch)
        $(".mes").each(function () {
            const mesId = $(this).attr("mesid");
            if (mesId !== undefined) {
                addSceneButtons(parseInt(mesId, 10));
            }
        });
    }
}

/**
 * Migrate characters from old global extension_settings storage to per-chat chat_metadata.
 * This handles the transition for users who had characters before the migration.
 */
function migrateGlobalCharacters() {
    const NAMESPACE = "rst";
    const globalChars = extension_settings[NAMESPACE]?.characters;
    if (globalChars && Object.keys(globalChars).length > 0) {
        // Only migrate if per-chat storage is empty (don't overwrite existing chat data)
        const chatChars = chat_metadata[NAMESPACE]?.characters;
        if (!chatChars || Object.keys(chatChars).length === 0) {
            console.log("[RST] Migrating", Object.keys(globalChars).length, "character(s) from global to per-chat storage");
            if (!chat_metadata[NAMESPACE]) {
                chat_metadata[NAMESPACE] = {};
            }
            chat_metadata[NAMESPACE].characters = globalChars;
            delete extension_settings[NAMESPACE].characters;
            saveChatDebounced();
            saveSettingsDebounced();
        }
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

    // Scene Begin button
    const $startBtn = $(`
        <div class="rst-scene-btn rst-scene-begin" title="Begin new scene">
            <i class="fa-solid fa-play"></i>
        </div>
    `);

    // Scene Conclude button
    const $endBtn = $(`
        <div class="rst-scene-btn rst-scene-conclude" title="Conclude current scene">
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

        // Prevent duplicate: check if this message already starts any scene
        const allScenes = getAllScenes();
        const alreadyStartsScene = allScenes.some((s) => s.messageStart === mesId);
        if (alreadyStartsScene) {
            toastr?.warning?.(`Message ${mesId} already starts a scene.`);
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
        if (!closedScene) {
            console.error("[RST] closeScene returned null for scene:", openScene.id, "status:", openScene.status);
            toastr?.error?.("Failed to close scene. The scene may have already been closed or the data is corrupted. Check the console for details.");
            return;
        }

        // Show processing indicator — disable button and show spinner
        $endBtn.addClass("rst-scene-processing");
        $endBtn.find("i").removeClass("fa-stop").addClass("fa-spinner fa-spin");
        toastr?.info?.("Scene closed. Generating stat updates... (may take a moment)");

        // Show persistent loading indicator in panel (survives tab switches)
        showPanelLoading("Generating stat updates...");

        // Trigger stat update flow
        try {
            const result = await generateStatUpdate(closedScene.id);

            // Store the scene title (if generated) — scene summary is saved only on user approval from Home tab
            if (result.sceneTitle) {
                updateSceneTitle(closedScene.id, result.sceneTitle);
            }

            // Store pending updates
            savePendingUpdates(result);

            toastr?.success?.("Stat updates ready for review! Check the Home tab.");

            // Refresh UI
            const $homePane = getPane("home");
            renderHomeTab($homePane);
            renderScenesTab(getPane("scenes"));
        } catch (err) {
            console.error("[RST] Stat update failed after scene close:", err);
            toastr?.error?.("Stat update generation failed. Please try again from the Home tab.");
        } finally {
            // Hide persistent loading indicator
            hidePanelLoading();

            // Restore button state
            $endBtn.removeClass("rst-scene-processing");
            $endBtn.find("i").removeClass("fa-spinner fa-spin").addClass("fa-stop");
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
