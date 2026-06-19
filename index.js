/**
 * index.js — Extension entry point
 * Registers the RST extension with SillyTavern, initializes UI, and binds events
 */

import {
    chat,
    chat_metadata,
    name1,
    saveSettingsDebounced,
    saveChatDebounced,
} from "../../../../script.js";

import { eventSource, event_types } from "../../../../scripts/events.js";
import { extension_settings } from "../../../../scripts/extensions.js";

import { initSettings, isEnabled, getSetting } from "./settings.js";
import { getSettings, getPresentCharacters, savePresentCharacters, getNameBlacklist, getMessageCounter, incrementMessageCounter, getPendingUpdates, savePendingUpdates } from "./data/storage.js";
import { createCharacter, findCharacterByName, findCharacterByFuzzyName } from "./data/characters.js";
import { createScene, closeScene, getOpenScene, initSceneCounter, getAllScenes, isMessageInScene, updateSceneSummary, updateSceneTitle } from "./data/scenes.js";
import { detectCharacters } from "./llm/sidecar.js";
import { generateStatUpdate } from "./llm/statUpdate.js";
import { updateInjection, removeInjection } from "./inject/promptInjector.js";
import { createPanel, renderHomeHeader, getPane, switchTab, showPanelLoading, hidePanelLoading } from "./ui/panel.js";
import { renderHomeTab } from "./ui/home.js";
import { renderLibraryTab, selectCharacter, showNewCharacterDetected } from "./ui/library.js";
import { renderScenesTab } from "./ui/scenes.js";
import { renderSettingsTab } from "./ui/settings.js";
import { registerStatLookupTool } from "./llm/statTool.js";
import { dlog } from "./lib/debug.js";

// ─── Extension Constants ──────────────────────────────────

const EXTENSION_NAME = "rst";

// ─── Re-entrancy guard ───────────────────────────────────
// Prevents overlapping sidecar detection calls that could cause connection profile churn
let _sidecarRunning = false;

// ─── Message deduplication guard ─────────────────────────
// ST may fire MESSAGE_RECEIVED/SENT multiple times for the same message
// (e.g., during streaming + at completion). This Set prevents double-counting.
const _processedMesIds = new Set();

// ─── Rejected names (in-memory, session-only) ────────────
// Names the user clicked "Ignore" on in the new-character popup.
// Prevents repeated popups for the same name within a session.
const _rejectedNames = new Set();

// ─── jQuery Extension init ────────────────────────────────

/**
 * Main entry point — called by SillyTavern when the extension loads.
 */
jQuery(async () => {
    dlog("[RST] Relationship Stat Tracker loading...");

    let $homePane = null;

    try {
        // 1. Initialize settings. If this fails, the extension cannot safely run.
        await initSettings();

        // 2. Create the UI panel EARLY. This prevents a later data/schema error
        // from making the extension look completely invisible in ST.
        createPanel();
        $homePane = getPane("home");

        // 3. Render the Home tab header immediately so there is visible UI even
        // if a later tab render fails on old/corrupt chat data.
        safeStep("renderHomeHeader", () => renderHomeHeader($homePane));

        // 4. Initialize scene counter after the panel exists. Old exports/chats
        // may be missing scenes; storage.js now migrates those defensively.
        safeStep("initSceneCounter", () => initSceneCounter());

        // 5. Render all tab content independently. One broken tab should not
        // prevent the whole extension from loading.
        safeStep("renderHomeTab", () => renderHomeTab($homePane));
        safeStep("renderLibraryTab", () => renderLibraryTab(getPane("lib")));
        safeStep("renderScenesTab", () => renderScenesTab(getPane("scenes")));
        safeStep("renderSettingsTab", () => renderSettingsTab(getPane("settings")));

        // 6. Register event handlers
        safeStep("registerEventHandlers", () => registerEventHandlers());

        // 7. Register slash commands
        safeStep("registerSlashCommands", () => registerSlashCommands());

        // 8. Initial injection update
        if (isEnabled()) {
            safeStep("updateInjection", () => updateInjection());
        }

        // 9. Listen for APP_READY — ST emits this after full initialization,
        //    after all extensions have loaded and messages are rendered.
        //    CHAT_CHANGED may fire before the extension registers its handler,
        //    so we use APP_READY as the reliable trigger to re-add buttons.
        safeStep("APP_READY registration", () => {
            const readyHandler = () => {
                if (!isEnabled()) return;
                $(".mes").each(function () {
                    const mesId = $(this).attr("mesid");
                    if (mesId !== undefined) {
                        addSceneButtons(parseInt(mesId, 10));
                    }
                });
            };
            if (typeof eventSource.once === "function") {
                eventSource.once(event_types.APP_READY, readyHandler);
            } else {
                eventSource.on(event_types.APP_READY, readyHandler);
            }
        });

        // 9a. Register the entry in ST's magic wand menu (chatbar dropdown)
        safeStep("registerMagicWandMenuEntry", () => registerMagicWandMenuEntry());

        // 9c. Register the relationship-stat lookup function tool so the main
        // LLM can request stats for characters that aren't present in the scene.
        safeStep("registerStatLookupTool", () => registerStatLookupTool());

        // 9. Listen for tab switches to refresh content
        $(document).on("rst:tab-switched", (_e, tabId) => {
            const $pane = getPane(tabId);
            switch (tabId) {
                case "home":
                    safeStep("refresh home tab", () => renderHomeTab($pane));
                    break;
                case "lib":
                    safeStep("refresh library tab", () => renderLibraryTab($pane));
                    break;
                case "scenes":
                    safeStep("refresh scenes tab", () => renderScenesTab($pane));
                    break;
                case "settings":
                    safeStep("refresh settings tab", () => renderSettingsTab($pane));
                    break;
            }
        });

        // 10. Listen for character selection from Home tab
        $(document).on("rst:select-character", (_e, charId) => {
            safeStep("selectCharacter", () => selectCharacter(charId));
        });

        // 11. Listen for toggle
        $(document).on("rst:toggle", (_e, enabled) => {
            if (enabled) {
                safeStep("toggle updateInjection", () => updateInjection());
                $(".rst-scene-btn").show();
                $(".rst-scene-btn").prop("disabled", false);
                $("body").removeClass("rst-disabled");
                $("#rst_container").css({ opacity: "", pointerEvents: "", userSelect: "" });
            } else {
                safeStep("toggle removeInjection", () => removeInjection());
                $(".rst-scene-btn").hide();
                $(".rst-scene-btn").prop("disabled", true);
                $("body").addClass("rst-disabled");
                $("#rst_container").css({ opacity: "0.45", pointerEvents: "none", userSelect: "none" });
                // Keep the toggle switch itself clickable
                $("#rst_container .rst-toggle").css({ pointerEvents: "auto", cursor: "pointer" });
                $("#rst_container .rst-toggle *").css({ pointerEvents: "auto" });
            }
        });

        dlog("[RST] Relationship Stat Tracker loaded successfully.");
    } catch (err) {
        console.error("[RST] Failed to load:", err);
        try { window.rstLastLoadError = err; } catch (_) {}
        // If we failed after the panel was created, leave a visible error on Home
        // instead of silently disappearing.
        try {
            const $pane = $homePane || getPane("home");
            if ($pane?.length) {
                $pane.append(`<div class="rst-card" style="border-color:#b44;color:#f3b4b4">RST failed during startup. Check F12 Console for <code>[RST] Failed to load</code>.</div>`);
            }
        } catch (_) {}
    }
});

/**
 * Run a boot/render step without allowing it to make the whole extension vanish.
 * @param {string} label
 * @param {Function} fn
 */
function safeStep(label, fn) {
    try {
        return fn();
    } catch (err) {
        console.error(`[RST] ${label} failed:`, err);
        try { window.rstLastLoadError = err; } catch (_) {}
        return null;
    }
}

// ─── Event Handlers ───────────────────────────────────────

/**
 * Register all SillyTavern event handlers.
 */
function registerEventHandlers() {
    // Character message rendered — add scene buttons only (no sidecar)
    // Sidecar does NOT run on AI responses — injection doesn't change
    // mid-turn. Detection runs only on MESSAGE_SENT so the AI has
    // updated present-character context before generating.
    eventSource.on(event_types.MESSAGE_RECEIVED, (mesId) => {
        onMessageReceived(mesId, true);
    });

    // User message rendered — add scene buttons + sidecar check
    eventSource.on(event_types.MESSAGE_SENT, (mesId) => {
        onMessageReceived(mesId, false);
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
            if (added > 0) dlog(`[RST] Added scene buttons to ${added} message(s)`);
        }, 300);
    });
}

/**
 * Handle a new message (sent or received).
 * - Add Scene Start/End buttons to the message bar
 * - Run sidecar detection if scan frequency is met
 * @param {number} mesId
 */
async function onMessageReceived(mesId, skipSidecar = false) {
    if (!isEnabled()) {
        dlog("[RST] onMessageReceived: RST disabled, skipping (mesId=" + mesId + ")");
        return;
    }

    // ── Deduplication: skip if this mesId was already processed ──
    if (mesId !== undefined && _processedMesIds.has(mesId)) {
        dlog("[RST] onMessageReceived: skipping duplicate mesId=" + mesId);
        return;
    }
    if (mesId !== undefined) {
        _processedMesIds.add(mesId);
    }

    // Add scene buttons to message bar (always — even when sidecar is skipped)
    addSceneButtons(mesId);

    // Sidecar detection — only runs on MESSAGE_SENT, not MESSAGE_RECEIVED
    // This ensures the injection is updated before the AI generates, but doesn't
    // change between user messages based on what the AI happened to say.
    if (skipSidecar) {
        return;
    }

    // Sidecar detection check
    const settings = getSettings();
    const counter = incrementMessageCounter();
    const frequency = settings.scanFrequency || 5;

    dlog("[RST] onMessageReceived: mesId=" + mesId + " counter=" + counter + " frequency=" + frequency +
        " shouldFire=" + (counter % frequency === 0));

    if (counter % frequency === 0) {
        // Re-entrancy guard — skip if a sidecar detection is already in progress
        if (_sidecarRunning) {
            console.warn("[RST] Sidecar detection already in progress, skipping duplicate call (counter=" + counter + ")");
            return;
        }

        _sidecarRunning = true;
        const profileName = settings.connections?.sidecarLLM || "(none)";
        dlog("[RST] Sidecar detection start (counter=" + counter + ", frequency=" + frequency + ", profile=" + profileName + ")");

        try {
            const result = await detectCharacters();

            dlog("[RST] Sidecar detection result — detected:", result.detected.length, "unknown:", result.unknown.length);

            // Build exclusion set from ST user persona name + hardcoded placeholders + per-chat blacklist
            const personaName = (name1 || "").toLowerCase().trim();
            const blacklist = (getNameBlacklist() || []).map((n) => n.toLowerCase().trim()).filter(Boolean);
            const EXCLUDED_NAMES = new Set([
                "{{user}}",
                "user",
                "User",
                personaName,
                ...blacklist,
            ]);

            // Filter out excluded and previously-rejected names
            const filteredDetected = result.detected.filter((name) => {
                const n = name.toLowerCase().trim();
                return !EXCLUDED_NAMES.has(n) && !_rejectedNames.has(n);
            });
            const filteredUnknown = result.unknown.filter((name) => {
                const n = name.toLowerCase().trim();
                return !EXCLUDED_NAMES.has(n) && !_rejectedNames.has(n);
            });

            // Build detected character IDs:
            // - filteredDetected: already canonical names from categorizeNames() — map directly
            //   via exact name match (no need to re-fuzzy-match, that was already done in
            //   categorizeNames() which does exact variant + fuzzy matching).
            // - filteredUnknown: raw LLM names that didn't match any known character —
            //   give them ONE pass of fuzzy matching as a second chance.
            const detectedIds = new Set();
            for (const name of filteredDetected) {
                const existing = findCharacterByName(name);
                if (existing) {
                    detectedIds.add(existing.id);
                }
            }
            for (const unknownName of filteredUnknown) {
                const existing = findCharacterByFuzzyName(unknownName) || findCharacterByName(unknownName);
                if (existing && !detectedIds.has(existing.id)) {
                    detectedIds.add(existing.id);
                }
            }

            // Handle truly unknown characters — with rejection tracking to prevent repeat popups.
            let newDetected = [...detectedIds];
            for (const unknownName of filteredUnknown) {
                // Skip names that already matched via fuzzy matching above
                const alreadyMatched = findCharacterByFuzzyName(unknownName) || findCharacterByName(unknownName);
                if (alreadyMatched) continue;

                if (settings.newCharPopup) {
                    const created = await showNewCharacterDetected(unknownName);
                    if (created) {
                        // Character was created — re-find and include as present
                        const newChar = findCharacterByFuzzyName(unknownName) || findCharacterByName(unknownName);
                        if (newChar && !detectedIds.has(newChar.id)) {
                            newDetected.push(newChar.id);
                            detectedIds.add(newChar.id);
                        }
                    } else {
                        // User clicked "Ignore" — track to prevent repeat popups this session
                        _rejectedNames.add(unknownName.toLowerCase().trim());
                        dlog("[RST] Name rejected by user, added to session rejection set:", unknownName);
                    }
                }
            }

            // Only update present characters + injection if the list actually changed
            const currentPresent = getPresentCharacters();
            const changed = newDetected.length !== currentPresent.length ||
                !newDetected.every((id) => currentPresent.includes(id));

            if (changed) {
                dlog("[RST] Present characters changed — old:", currentPresent.length, "new:", newDetected.length, ". Updating.");
                // Always save — if empty, clears the present list; if non-empty, updates it
                savePresentCharacters(newDetected);
                updateInjection();
            } else {
                dlog("[RST] Present characters unchanged — skipping injection update.");
            }

            // Refresh both Home and Library tabs if visible so present-indicator UI stays in sync
            const $homePane = getPane("home");
            if ($homePane.hasClass("on")) {
                renderHomeTab($homePane);
            }
            const $libPane = getPane("lib");
            if ($libPane.hasClass("on")) {
                renderLibraryTab($libPane);
            }
        } catch (err) {
            console.error("[RST] Sidecar detection error:", err);
        } finally {
            _sidecarRunning = false;
            dlog("[RST] Sidecar detection complete");
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
            dlog(`[RST] Chat switched with ${totalUpdates} pending update(s) across ${pendingScenes.length} scene(s).`);
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
            dlog("[RST] Migrating", Object.keys(globalChars).length, "character(s) from global to per-chat storage");
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
    if (!isEnabled()) return;

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

        // Prevent starting a scene on a message that's already part of a closed scene
        const alreadyInScene = allScenes.some((s) => s.status === "closed" && isMessageInScene(s, mesId));
        if (alreadyInScene) {
            toastr?.warning?.("This message is already part of a closed scene.");
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

// ─── Magic Wand Menu Entry (Chat Bar Popout) ─────────────

/**
 * Reference to the popout visibility flag.
 * @type {boolean}
 */
let rstPopoutVisible = false;

/**
 * Reference to the RST popout jQuery element.
 * @type {jQuery|null}
 */
let $rstPopout = null;

/**
 * Adds an entry for RST in ST's magic wand dropdown (#extensionsMenu).
 * Third-party extensions are NOT auto-discovered in the wand menu — each
 * extension must self-register. This follows the same pattern used by
 * TypefaceR, Extension-Notebook, and Narrative-World-State-Tracker.
 *
 * Clicking the wand entry toggles a standalone floating popup (TypefaceR
 * pattern) — it does NOT open the sidebar extensions drawer.
 */
function registerMagicWandMenuEntry() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) {
        dlog('[RST] Magic wand menu (#extensionsMenu) not found — cannot register wand entry.');
        return;
    }

    // Prevent duplicate entries if init is somehow called again
    if (document.getElementById('rst-wand-entry')) {
        return;
    }

    const entry = document.createElement('div');
    entry.id = 'rst-wand-entry';
    entry.className = 'list-group-item flex-container flexGap5 interactable';
    entry.title = 'Open Relationship Stat Tracker';
    entry.tabIndex = 0;
    entry.innerHTML = `
        <i class="fa-solid fa-heart"></i>
        <span>Relationship Stats</span>
    `;

    // NOTE: No e.stopPropagation() here — that would prevent the magic wand
    // dropdown from closing. ST's extensions.js listens for clicks on $('html')
    // to close the dropdown, and stopPropagation() blocks that handler.
    entry.addEventListener('click', function () {
        // Toggle the standalone floating popup — NOT the sidebar drawer
        if (rstPopoutVisible) {
            closeRstPopout();
        } else {
            openRstPopout();
        }
    });

    menu.appendChild(entry);
    dlog('[RST] Magic wand menu entry registered.');
}

/**
 * Opens a standalone floating popup (like TypefaceR's popout) that contains
 * the RST panel content. This is the pattern used by ALL third-party
 * extensions in ST's magic wand menu — they open their own independent
 * floating UI, NOT the sidebar extensions drawer.
 *
 * IMPORTANT: The drawer content is MOVED (not cloned) to the popout to avoid
 * duplicate-ID issues. The `buildTab()` functions in ui/panel.js use
 * document.getElementById() which only finds the FIRST element with that ID.
 * Cloning creates duplicates — buildTab() would populate the hidden original
 * instead of the visible clone. Moving avoids this entirely. When the popout
 * closes, the content is moved back to the sidebar drawer.
 *
 * References:
 *   - TypefaceR:  openPopout() clones drawer content into a draggable popup
 *   - Notebook:   creates a panel in #movingDivs and toggles its visibility
 */
function openRstPopout() {
    if (rstPopoutVisible) return;

    const $drawerContent = $('#rst_container .inline-drawer-content');
    if ($drawerContent.length === 0) {
        dlog('[RST] Drawer content not found — cannot open popout.');
        return;
    }

    // Create the floating popup container (matches TypefaceR pattern)
    $rstPopout = $(`
        <div id="rst-popout" class="draggable">
            <div id="rst-popout-header" class="rst-popout-header">
                <div class="rst-popout-title">
                    <i class="fa-solid fa-heart"></i>
                    <span>Relationship Stat Tracker</span>
                </div>
                <div class="rst-popout-close" title="Close">
                    <i class="fa-solid fa-xmark"></i>
                </div>
            </div>
            <div id="rst-popout-content"></div>
        </div>
    `);

    // Append to body
    $('body').append($rstPopout);


    // ── MOVE the drawer content into the popout (do NOT clone) ──
    // Cloning creates duplicate IDs, and buildTab() uses document.getElementById()
    // which only finds the first (hidden) element. Moving ensures no duplicates.
    const popoutContent = $rstPopout.find('#rst-popout-content')[0];
    const drawerContentEl = $drawerContent[0];
    // Detach from sidebar drawer and append to popout
    popoutContent.appendChild(drawerContentEl);

    // Close button handler
    $rstPopout.find('.rst-popout-close').on('click', closeRstPopout);

    // Close on Escape key
    $(document).on('keydown.rst_popout', (e) => {
        if (e.key === 'Escape') {
            closeRstPopout();
        }
    });

    // Make draggable using ST's built-in dragElement (from RossAscends-mods.js)
    if (typeof window.dragElement === 'function') {
        window.dragElement($rstPopout);
    }

    // Fade in
    $rstPopout.fadeIn(200);
    rstPopoutVisible = true;
    dlog('[RST] Popout opened.');
}

function closeRstPopout() {
    if (!rstPopoutVisible || !$rstPopout) return;

    // ── Move the content back to the sidebar drawer ──
    const popoutContent = document.getElementById('rst-popout-content');
    const drawerContent = popoutContent?.firstElementChild; // .inline-drawer-content

    $rstPopout.fadeOut(200, () => {
        // Move content back inside the original .inline-drawer parent
        // (NOT #rst_container — content was originally a child of .inline-drawer)
        if (drawerContent) {
            const $drawerParent = $('#rst_container .inline-drawer');
            if ($drawerParent.length > 0) {
                $drawerParent.append(drawerContent);
            } else {
                // Fallback: just append to #rst_container if .inline-drawer is gone
                $('#rst_container').append(drawerContent);
            }
        }
        $rstPopout.remove();
        $rstPopout = null;
    });

    rstPopoutVisible = false;
    $(document).off('keydown.rst_popout');
    dlog('[RST] Popout closed.');
}

// ─── Slash Commands ───────────────────────────────────────

/**
 * Register slash commands for RST.
 */
function registerSlashCommands() {
    // These would use ST's SlashCommandParser if available
    // For now, we'll add them as a TODO since the exact API depends on ST version
    dlog("[RST] Slash commands registered (placeholder)");
}
