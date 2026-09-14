import { captureChatScope, invalidateChatScopes } from "./lib/chatScope.js";
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
import {
    getSettings,
    getPresentCharacters,
    savePresentCharacters,
    savePresenceModes,
    getPresenceModes,
    addNamesToBlacklist,
    isNameBlacklisted,
    setMessageCounter,
    syncMessageCounterToLiveCount,
    setSidecarRetryDue,
    getSidecarPauseCadence,
    saveSidecarPauseCadence,
    clearSidecarPauseCadence,
    getPendingUpdates,
    savePendingUpdates,
} from "./data/storage.js";
import { createCharacter, findCharacterByName, findCharacterByFuzzyName } from "./data/characters.js";
import { createScene, closeScene, getOpenScene, initSceneCounter, getAllScenes, isMessageInScene, updateSceneSummary, updateSceneTitle } from "./data/scenes.js";
import { detectCharacters } from "./llm/sidecar.js";
import { generateStatUpdate, isStatUpdateRunning } from "./llm/statUpdate.js";
import { updateInjection, removeInjection } from "./inject/promptInjector.js";
import { createPanel, renderHomeHeader, getPane, switchTab, showPanelLoading, hidePanelLoading } from "./ui/panel.js";
import { renderHomeTab, refreshSidecarCadenceDisplay, setSidecarCadenceRunning } from "./ui/home.js";
import { renderLibraryTab, selectCharacter, showNewCharacterDetected } from "./ui/library.js";
import { renderScenesTab } from "./ui/scenes.js";
import { renderSettingsTab } from "./ui/settings.js";
import { registerStatLookupTool } from "./llm/statTool.js";
import { dlog } from "./lib/debug.js";
import { isNarrativeMessage, narrativeMessages } from "./lib/chatMessages.js";

// ─── Extension Constants ──────────────────────────────────

const EXTENSION_NAME = "rst";

// ─── Re-entrancy guard ───────────────────────────────────
// Prevents overlapping sidecar detection calls that could cause connection profile churn
let _sidecarRunning = false;

// Invalidates asynchronous sidecar work when its owning chat or pause state
// changes. A result is allowed to mutate presence only in the exact lifecycle
// generation in which it started.
let _sidecarGeneration = 0;

// ─── Message deduplication guard ─────────────────────────
// ST may fire MESSAGE_RECEIVED/SENT multiple times for the same message
// (e.g., during streaming + at completion). This Set prevents double-counting.
// Important: this is session-only and must be cleared if the live chat shrinks
// after message deletion, because SillyTavern reuses/renumbers mesIds.
const _processedMesIds = new Set();

// Tracks the live chat size so deletion/renumbering can be detected even if ST
// does not emit a dedicated delete event before the next MESSAGE_SENT/RECEIVED.
let _lastObservedChatLength = Array.isArray(chat) ? chat.length : 0;

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

        // 7. Initial injection update
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

// ─── Runtime Message State ────────────────────────────────

/**
 * Return the current live chat message count, preferring the event mesId when it
 * is available because ST passes the freshly rendered message index directly.
 * ST mesIds are zero-based, so mesId 143 means 144 live message slots.
 * @param {number|string|null} [mesId]
 * @returns {number}
 */
function getLiveMessageCount(mesId = null) {
    return narrativeMessages(chat).length;
}

/**
 * Keep session-only message bookkeeping aligned with the live chat. This fixes
 * the "deleted OOC messages strand the sidecar until the old message number"
 * case by clearing processed mesIds when the chat shrinks, then clamping the
 * saved sidecar counter so it cannot point past the current chat length.
 * @param {string} reason
 * @param {number|string|null} [mesId]
 * @returns {number} current live message count
 */
function syncRuntimeMessageState(reason = "unknown", mesId = null) {
    const liveCount = getLiveMessageCount(mesId);

    if (liveCount < _lastObservedChatLength) {
        const previousLength = _lastObservedChatLength;
        _processedMesIds.clear();
        const sync = syncMessageCounterToLiveCount(liveCount);
        setSidecarRetryDue(false);
        dlog(`[RST] Live chat shrank (${previousLength} → ${liveCount}) during ${reason}; cleared processed message IDs.` +
            (sync.changed ? ` Sidecar counter clamped ${sync.previous} → ${sync.counter}.` : ""));
    } else {
        const sync = syncMessageCounterToLiveCount(liveCount);
        if (sync.changed) {
            dlog(`[RST] Sidecar counter clamped ${sync.previous} → ${sync.counter} during ${reason}.`);
        }
    }

    _lastObservedChatLength = liveCount;
    return liveCount;
}

/**
 * Chat switches and destructive edits invalidate session-only mesId caches.
 * Per-chat RST data is stored in chat_metadata, but the processed-id guard is
 * only in memory, so it must be reset when the visible chat changes shape.
 * @param {string} reason
 */
function resetRuntimeMessageState(reason = "chat changed") {
    _processedMesIds.clear();
    const destructiveMutation = ["MESSAGE_DELETED", "MESSAGE_EDITED", "MESSAGE_SWIPED", "CHAT_DELETED"].includes(reason);
    if (destructiveMutation) {
        // The message evidence that an in-flight request owns has changed. Invalidate
        // that request at the same lifecycle boundary that resets cadence bookkeeping;
        // a stale pre-edit result must never commit into the edited chat.
        _sidecarGeneration++;
        setSidecarRetryDue(false);
    }
    _lastObservedChatLength = getLiveMessageCount();
    const sync = syncMessageCounterToLiveCount(_lastObservedChatLength);
    refreshSidecarCadenceDisplay(_lastObservedChatLength);
    dlog(`[RST] Runtime message state reset (${reason}); liveCount=${_lastObservedChatLength}` +
        (sync.changed ? `, sidecar counter clamped ${sync.previous} → ${sync.counter}` : ""));
}


/**
 * Snapshot cadence progress without consuming or resetting it. Paused messages
 * are intentionally excluded from cadence, so this anchor is held until resume.
 * @param {number} liveCount
 * @returns {{liveCount:number, baseline:number}}
 */
function captureSidecarPauseCadence(liveCount = getLiveMessageCount(), force = false) {
    const sync = syncMessageCounterToLiveCount(liveCount);
    const existing = getSidecarPauseCadence();
    if (!force && existing) return existing;
    return saveSidecarPauseCadence(liveCount, sync.counter);
}

/**
 * Restore the same cadence progress against the current live chat length. Any
 * narrative messages added while paused are skipped rather than counted toward
 * the next scan. Example: pausing at 2/3 resumes at 2/3, not 0/3 or 3/3.
 * @param {number} liveCount
 * @returns {number} restored baseline
 */
function restoreSidecarPauseCadence(liveCount = getLiveMessageCount()) {
    const snapshot = getSidecarPauseCadence();
    if (!snapshot) {
        return syncMessageCounterToLiveCount(liveCount).counter;
    }

    const progressAtPause = Math.max(0, snapshot.liveCount - snapshot.baseline);
    const preservedProgress = Math.min(progressAtPause, Math.max(0, liveCount));
    const restoredBaseline = Math.max(0, Math.floor(liveCount) - preservedProgress);
    setMessageCounter(restoredBaseline);
    clearSidecarPauseCadence();
    return restoredBaseline;
}

// ─── Event Handlers ───────────────────────────────────────

/**
 * Register all SillyTavern event handlers.
 */
function registerEventHandlers() {
    $(document).on("rst:profiles-changed", () => updateInjection());
    // Check cadence on BOTH halves of the exchange. MESSAGE_RECEIVED fires
    // after the assistant generation has completed, so reconciling presence here
    // cannot alter the response that just finished. This also lets an unknown NPC
    // introduced by the assistant reach the approval popup as soon as the cadence
    // threshold is met instead of waiting for a later message boundary.
    eventSource.on(event_types.MESSAGE_RECEIVED, (mesId) => {
        onMessageReceived(mesId, true);
    });

    // User message rendered — add scene buttons + the same cadence check.
    eventSource.on(event_types.MESSAGE_SENT, (mesId) => {
        onMessageReceived(mesId, false);
    });

    // Chat changed — re-render everything
    eventSource.on(event_types.CHAT_CHANGED, () => {
        onChatChanged();
    });

    // Pause is a hard transaction boundary. Invalidate in-flight work, but
    // freeze cadence exactly where it is instead of restarting the countdown.
    $(document).on("rst:sidecar-pause-changed", (_event, paused) => {
        _sidecarGeneration++;
        const liveCount = getLiveMessageCount();
        if (paused) {
            const snapshot = captureSidecarPauseCadence(liveCount, true);
            const progress = Math.max(0, snapshot.liveCount - snapshot.baseline);
            dlog(`[RST] Sidecar paused; cadence frozen at ${progress} message(s) of progress.`);
        } else {
            const restoredBaseline = restoreSidecarPauseCadence(liveCount);
            dlog(`[RST] Sidecar resumed; cadence baseline restored to ${restoredBaseline} at liveCount=${liveCount}.`);
        }
        refreshSidecarCadenceDisplay(liveCount);
    });

    // Message deletion/edits can renumber mesIds without a full extension reload.
    // Register defensively only for event names that exist in this ST build.
    ["MESSAGE_DELETED", "MESSAGE_EDITED", "MESSAGE_SWIPED", "CHAT_DELETED"].forEach((eventName) => {
        const eventType = event_types[eventName];
        if (!eventType) return;
        eventSource.on(eventType, () => resetRuntimeMessageState(eventName));
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
 * @param {boolean} fromAssistant True when triggered by MESSAGE_RECEIVED.
 */
async function onMessageReceived(mesId, fromAssistant = false) {
    if (!isEnabled()) {
        dlog("[RST] onMessageReceived: RST disabled, skipping (mesId=" + mesId + ")");
        return;
    }

    const message = Array.isArray(chat) && Number.isInteger(Number(mesId)) ? chat[Number(mesId)] : null;
    if (message && !isNarrativeMessage(message)) {
        dlog("[RST] Ignoring non-narrative message event (mesId=" + mesId + ")");
        return;
    }
    const liveCount = syncRuntimeMessageState("message event", mesId);
    refreshSidecarCadenceDisplay(liveCount);

    // ── Deduplication: skip if this mesId was already processed ──
    // If messages were deleted, syncRuntimeMessageState() clears this Set before
    // we get here, so newly-renumbered messages are not mistaken for old ones.
    if (mesId !== undefined && _processedMesIds.has(mesId)) {
        dlog("[RST] onMessageReceived: skipping duplicate mesId=" + mesId);
        return;
    }
    if (mesId !== undefined) {
        _processedMesIds.add(mesId);
    }

    // Add scene buttons to message bar (always — even when sidecar is skipped)
    addSceneButtons(mesId);

    // A paused sidecar consumes neither cadence nor presence transitions. Keep
    // the original pause snapshot intact; do NOT move messageCounter to liveCount,
    // because that would restart a partially completed cadence on resume.
    const settings = getSettings();
    if (settings.sidecarPaused === true) {
        captureSidecarPauseCadence(liveCount);
        refreshSidecarCadenceDisplay(liveCount);
        dlog("[RST] Sidecar paused — cadence frozen and presence detection skipped (liveCount=" + liveCount + ")");
        return;
    }

    // Sidecar detection check. MESSAGE_RECEIVED is safe here because it fires
    // after generation has completed. We still obey the exact same persisted
    // cadence, so this changes detection latency rather than request frequency.
    // The saved messageCounter is treated as the
    // live message count at the last sidecar scan/baseline, not as a permanent
    // high-water counter. That means deleted OOC messages cannot strand it in
    // the future.
    const frequency = settings.scanFrequency || 5;
    const sync = syncMessageCounterToLiveCount(liveCount);
    const lastScanCount = sync.counter;
    const messagesSinceScan = Math.max(0, liveCount - lastScanCount);
    const shouldFire = messagesSinceScan >= frequency;

    dlog("[RST] onMessageReceived: mesId=" + mesId +
        " liveCount=" + liveCount +
        " lastSidecarCount=" + lastScanCount +
        " sinceLastScan=" + messagesSinceScan +
        " frequency=" + frequency +
        " source=" + (fromAssistant ? "assistant" : "user") +
        " shouldFire=" + shouldFire);

    if (shouldFire) {
        // Re-entrancy guard — skip if a sidecar detection is already in progress
        if (_sidecarRunning) {
            console.warn("[RST] Sidecar detection already in progress, skipping duplicate call (liveCount=" + liveCount + ")");
            return;
        }

        _sidecarRunning = true;
        setSidecarCadenceRunning(true);
        const requestGeneration = _sidecarGeneration;
        const requestChatMetadata = chat_metadata;
        const requestIsCurrent = () => requestGeneration === _sidecarGeneration && requestChatMetadata === chat_metadata;
        const profileName = settings.connections?.sidecarLLM || "(none)";
        dlog("[RST] Sidecar detection start (liveCount=" + liveCount + ", frequency=" + frequency + ", profile=" + profileName + ")");

        try {
            // Pass the exact unprocessed span so no boundary transition is lost,
            // including when cadence becomes due on an assistant response.
            const scanWindow = Math.max(Number(settings.messagesToScan) || 10, messagesSinceScan);
            const result = await detectCharacters({
                messageCount: scanWindow,
                transitionMessageCount: messagesSinceScan,
            });

            if (!requestIsCurrent()) {
                dlog("[RST] Sidecar ownership changed during generation — discarding stale result");
                return;
            }

            // The user may pause the sidecar while a request is already in flight.
            // In that case, discard the result instead of changing presence state.
            if (getSetting("sidecarPaused", false)) {
                dlog("[RST] Sidecar paused during generation — discarding result");
                return;
            }

            dlog("[RST] Sidecar detection result — detected:", result.detected.length, "unknown:", result.unknown.length, "valid:", result.valid);

            // Malformed, truncated, or otherwise invalid sidecar output fails closed.
            // Preserve the current list rather than clearing it or accepting parser noise.
            if (result.valid === false) {
                setSidecarRetryDue(true);
                dlog("[RST] Presence reconciliation skipped; preserving current list. Reason:", result.reason || "invalid response");
                return;
            }

            const resultModes = result.modes && typeof result.modes === "object" ? result.modes : {};

            // Filter out excluded and previously-rejected names using normalized keys,
            // so case/dash/spacing variants don't leak through.
            const personaName = name1 || "";
            const isExcludedDetectedName = (name) => isNameBlacklisted(name, ["{{user}}", "user", personaName]);
            const filteredDetected = result.detected.filter((name) => !isExcludedDetectedName(name));
            const filteredUnknown = result.unknown.filter((name) => !isExcludedDetectedName(name));

            // Build detected character IDs:
            // - filteredDetected: already canonical names from categorizeNames() — map directly
            //   via exact name match (no need to re-fuzzy-match, that was already done in
            //   categorizeNames() which does exact variant + fuzzy matching).
            // - filteredUnknown: raw LLM names that didn't match any known character —
            //   give them ONE pass of fuzzy matching as a second chance.
            const detectedIds = new Set();
            const detectedModes = {};
            const normalizePresenceMode = (value) => {
                const mode = String(value || "").toLowerCase();
                return ["physical", "call", "surveillance", "message", "remote", "parallel"].includes(mode) ? mode : "unknown";
            };
            for (const name of filteredDetected) {
                const existing = findCharacterByName(name);
                if (existing) {
                    detectedIds.add(existing.id);
                    detectedModes[existing.id] = normalizePresenceMode(resultModes[name]);
                }
            }
            for (const unknownName of filteredUnknown) {
                if (!requestIsCurrent()) return;
                const existing = findCharacterByFuzzyName(unknownName) || findCharacterByName(unknownName);
                if (existing && !detectedIds.has(existing.id)) {
                    detectedIds.add(existing.id);
                    detectedModes[existing.id] = normalizePresenceMode(resultModes[unknownName]);
                }
            }

            // Handle truly unknown characters — with rejection tracking to prevent repeat popups.
            let newDetected = [...detectedIds];
            for (const unknownName of filteredUnknown) {
                // Skip names that already matched via fuzzy matching above
                const alreadyMatched = findCharacterByFuzzyName(unknownName) || findCharacterByName(unknownName);
                if (alreadyMatched) continue;

                // Missing legacy values mean enabled, matching the Settings UI and
                // the default setting. Only an explicit false disables prompts.
                if (settings.newCharPopup !== false) {
                    const created = await showNewCharacterDetected(unknownName, requestIsCurrent);
                    if (!requestIsCurrent()) {
                        dlog("[RST] Sidecar ownership changed during character confirmation — aborting commit");
                        return;
                    }
                    if (created === true) {
                        // Character was created — re-find and include as present
                        const newChar = findCharacterByFuzzyName(unknownName) || findCharacterByName(unknownName);
                        if (newChar && !detectedIds.has(newChar.id)) {
                            newDetected.push(newChar.id);
                            detectedIds.add(newChar.id);
                            detectedModes[newChar.id] = normalizePresenceMode(resultModes[unknownName]);
                        }
                    } else if (created === false) {
                        // Only an EXPLICIT click on "Ignore" blacklists the name. Closing
                        // the modal, Escape, or lifecycle cancellation leaves it eligible
                        // to be proposed again on a later scan.
                        const persisted = await Promise.resolve(addNamesToBlacklist(unknownName, true));
                        if (persisted === false) {
                            toastr?.warning?.(`Ignored ${unknownName}, but its blacklist entry could not be confirmed on disk.`);
                        }
                        dlog("[RST] Name rejected by user, added to blacklist:", unknownName);
                    } else {
                        dlog("[RST] New-character confirmation dismissed without a decision; not blacklisting:", unknownName);
                    }
                } else {
                    dlog("[RST] Unknown character detected but popup setting is explicitly disabled:", unknownName);
                }
            }

            // Only update present characters + injection if the list actually changed
            const currentPresent = getPresentCharacters();
            const uniqueDetected = [...new Set(newDetected)];
            const currentModes = getPresenceModes();
            const nextModes = {};
            for (const id of uniqueDetected) {
                nextModes[id] = detectedModes[id] || currentModes[id] || "unknown";
            }

            const changed = uniqueDetected.length !== currentPresent.length ||
                !uniqueDetected.every((id) => currentPresent.includes(id));
            const modesChanged = Object.keys(nextModes).length !== Object.keys(currentModes).length ||
                Object.entries(nextModes).some(([id, mode]) => currentModes[id] !== mode);

            if (!requestIsCurrent()) return;

            if (changed) {
                dlog("[RST] Present characters changed — old:", currentPresent.length, "new:", uniqueDetected.length, ". Updating.");
                // Always save — if empty, clears the present list; if non-empty, updates it
                savePresentCharacters(uniqueDetected);
                savePresenceModes(nextModes);
                updateInjection();
            } else {
                if (modesChanged) savePresenceModes(nextModes);
                dlog("[RST] Present characters unchanged — skipping injection update.");
            }

            // Commit cadence only after a valid result has been reconciled in
            // its owning chat. Failed or stale requests remain due for retry.
            setMessageCounter(liveCount);
            setSidecarRetryDue(false);

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
            setSidecarRetryDue(true);
            console.error("[RST] Sidecar detection error:", err);
        } finally {
            _sidecarRunning = false;
            setSidecarCadenceRunning(false);
            dlog("[RST] Sidecar detection complete");
        }
    }
}

/**
 * Handle chat change — re-initialize everything.
 * Warns if there are pending updates from the previous chat.
 */
function onChatChanged() {
    invalidateChatScopes();
    _sidecarGeneration++;
    resetRuntimeMessageState("CHAT_CHANGED");
    setSidecarCadenceRunning(false);

    // Pause is global but the cadence checkpoint is per chat. Capture a snapshot
    // for a chat entered while paused; clear stale snapshots when entered unpaused.
    const liveCount = getLiveMessageCount();
    if (getSetting("sidecarPaused", false)) captureSidecarPauseCadence(liveCount);
    else clearSidecarPauseCadence();

    const pending = getPendingUpdates();
    const count = pending?.characterUpdates?.length || 0;
    if (count) toastr?.info?.(`This chat has ${count} unapproved stat update(s). Review them on Home.`, "Pending Updates");

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
    // The blacklist is per-chat. Refresh Settings too, otherwise an open
    // textarea can continue displaying (and later save) the previous chat's list.
    renderSettingsTab(getPane("settings"));

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
        $(document).trigger("rst:scene-state-changed");

        // Refresh scenes tab
        renderScenesTab(getPane("scenes"));
    });

    $endBtn.on("click", async () => {
        // Prevent double-clicks from starting overlapping stat-update calls.
        if ($endBtn.hasClass("rst-scene-processing")) {
            toastr?.info?.("Scene close is already processing. Waiting for the stat-update LLM...");
            return;
        }

        const openScene = getOpenScene();
        if (!openScene) {
            toastr?.warning?.("No open scene to close.");
            return;
        }

        if (getPendingUpdates() || isStatUpdateRunning()) {
            toastr?.warning?.("Finish the current stat review before closing another scene.");
            return;
        }
        if (mesId < openScene.messageStart) {
            toastr?.warning?.("A scene cannot end before its starting message.");
            return;
        }

        // Close the scene immediately, before the expensive LLM call.
        // This makes the close operation visible even when GLM / the API is slow.
        const closedScene = closeScene(openScene.id, mesId);
        if (!closedScene) {
            console.error("[RST] closeScene returned null for scene:", openScene.id, "status:", openScene.status);
            toastr?.error?.("Failed to close scene. The scene may have already been closed or the data is corrupted. Check the console for details.");
            return;
        }

        // Reflect the closed state in the UI right away instead of waiting for
        // generateStatUpdate(). Without this, a slow GLM call makes the scene
        // look like it did not close until a refresh.
        $startBtn.removeClass("rst-scene-active");
        $(document).trigger("rst:scene-state-changed");
        renderScenesTab(getPane("scenes"));
        $(document).trigger("rst:refresh-message-buttons");

        // Show processing indicator — disable button and show spinner
        $endBtn.addClass("rst-scene-processing");
        $endBtn.find("i").removeClass("fa-stop").addClass("fa-spinner fa-spin");
        toastr?.info?.("Scene closed. Generating stat updates with the selected LLM...");

        // Show persistent loading indicator in panel (survives tab switches)
        showPanelLoading("Generating stat updates...");

        const startedAt = Date.now();
        const slowNoticeTimer = setTimeout(() => {
            toastr?.info?.("Still generating stat updates. The scene is already closed; the LLM call is just taking a while.");
            showPanelLoading("Still generating stat updates...");
        }, 45000);

        // Trigger stat update flow
        try {
            const scope = captureChatScope();
            const result = await scope.wait(() => generateStatUpdate(closedScene.id));

            // Store the scene title (if generated) — scene summary is saved only on user approval from Home tab
            if (result.sceneTitle) {
                updateSceneTitle(closedScene.id, result.sceneTitle);
            }

            // Store pending updates
            savePendingUpdates(result);

            const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
            toastr?.success?.(`Stat updates ready for review! Check the Home tab. (${elapsedSeconds}s)`);

            // Refresh UI
            const $homePane = getPane("home");
            renderHomeTab($homePane);
        } catch (err) {
            console.error("[RST] Stat update failed after scene close:", err);
            toastr?.error?.("Scene is closed, but stat update generation failed. Check the console for the LLM/API error.");
        } finally {
            clearTimeout(slowNoticeTimer);

            // Hide persistent loading indicator
            hidePanelLoading();

            // Restore button state
            $endBtn.removeClass("rst-scene-processing");
            $endBtn.find("i").removeClass("fa-spinner fa-spin").addClass("fa-stop");

            // Always refresh the scenes tab after the LLM stage, even on failure.
            renderScenesTab(getPane("scenes"));
            $(document).trigger("rst:refresh-message-buttons");
        }
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
