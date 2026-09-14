import { captureChatScope } from "../lib/chatScope.js";
/**
 * home.js — Home tab: toggle, pending updates, present characters
 * Renders the Home tab with pending update cards and present character list
 */

import { commitCharacterUpdate, isMeaningfulCharacterUpdate } from "../data/approval.js";
import { updateInjection } from "../inject/promptInjector.js";
import { getPendingUpdates, savePendingUpdates, getPresentCharacters, savePresentCharacters, getSettings, getMessageCounter, getSidecarPauseCadence, getSidecarRetryDue, deleteCharacterData } from "../data/storage.js";
import { getCharacterProfile, getInitials, getAllCharacters, updateCharacterProfile, STAT_CATEGORIES, STAT_NAMES } from "../data/characters.js";
import { getOpenScene, getSceneById, deleteScene, updateSceneSummary, updateSceneTitle } from "../data/scenes.js";
import { generateStatUpdate } from "../llm/statUpdate.js";
import { renderScenesTab } from "./scenes.js";
import { renderLibraryTab } from "./library.js";
import { switchTab, getPane, showPanelLoading, hidePanelLoading, refreshHomeHeaderStatus } from "./panel.js";
import { chat } from "../../../../../script.js";
import { Popup, POPUP_RESULT, POPUP_TYPE } from "../../../../../scripts/popup.js";
import { dlog } from "../lib/debug.js";
import { narrativeMessages } from "../lib/chatMessages.js";
import { getRelationshipConditionDefinition, MAX_ACTIVE_RELATIONSHIP_CONDITIONS } from "../data/conditions.js";

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

// ─── Sidecar Cadence Display ─────────────────────────────

let _sidecarScanRunning = false;

/**
 * Refresh the quiet Home-tab sidecar cadence indicator.
 *
 * The scheduler checks cadence on both MESSAGE_SENT and MESSAGE_RECEIVED.
 * Both user and character messages advance the same persisted countdown, so
 * checking both event types improves timing without increasing scan frequency.
 */
export function refreshSidecarCadenceDisplay(liveCountOverride = null) {
    const $row = $("#rst-sidecar-cadence");
    const $text = $("#rst-sidecar-cadence-text");
    if (!$row.length || !$text.length) return;

    const settings = getSettings();
    const enabled = settings.enabled !== false;
    const paused = settings.sidecarPaused === true;
    const frequency = Math.max(1, Number(settings.scanFrequency) || 5);
    const parsedLiveCount = Number(liveCountOverride);
    const liveCount = liveCountOverride !== null && liveCountOverride !== undefined && Number.isFinite(parsedLiveCount) && parsedLiveCount >= 0
        ? Math.floor(parsedLiveCount)
        : narrativeMessages(chat).length;
    const lastBaseline = Math.max(0, Number(getMessageCounter()) || 0);
    const pauseSnapshot = paused ? getSidecarPauseCadence() : null;
    const cadenceLiveCount = pauseSnapshot ? pauseSnapshot.liveCount : liveCount;
    const cadenceBaseline = pauseSnapshot ? pauseSnapshot.baseline : lastBaseline;
    const sinceBaseline = Math.max(0, cadenceLiveCount - Math.min(cadenceBaseline, cadenceLiveCount));
    const nextIn = Math.max(0, frequency - sinceBaseline);
    const retryDue = getSidecarRetryDue();

    let status = "ready";
    let label = "";

    if (!enabled) {
        status = "disabled";
        label = "Sidecar disabled.";
    } else if (paused) {
        status = "paused";
        label = "Sidecar paused.";
    } else if (_sidecarScanRunning) {
        status = "scanning";
        label = "Sidecar scan running…";
    } else if (nextIn === 0) {
        status = retryDue ? "retry" : "due";
        label = retryDue ? "Sidecar ready · retry due" : "Sidecar ready · scan due";
    } else {
        label = `Sidecar ready · next scan in ${nextIn} message${nextIn === 1 ? "" : "s"}`;
    }

    $row.attr("data-status", status);
    $text.text(label);
    $row.attr(
        "title",
        `Cadence counts live chat messages (user + character). When the cadence becomes due, the sidecar may run after either a user or character message. ${sinceBaseline}/${frequency} messages since the current baseline.${retryDue ? " The previous sidecar attempt did not commit a valid result, so the same cadence checkpoint remains due for retry." : ""}`
    );
}

/**
 * Mark the sidecar request as running/not running for the Home indicator.
 * @param {boolean} running
 */
export function setSidecarCadenceRunning(running) {
    _sidecarScanRunning = Boolean(running);
    refreshSidecarCadenceDisplay();
}

$(document).on("rst:refresh-sidecar-cadence", () => refreshSidecarCadenceDisplay());

// ─── Main Render ──────────────────────────────────────────

/**
 * Render the full Home tab content.
 * @param {jQuery} $pane
 */
export function renderHomeTab($pane) {
    // The header is persistent while Home content re-renders. Refresh its
    // open-scene label so chat switches and scene lifecycle changes cannot
    // leave stale status text behind.
    refreshHomeHeaderStatus();

    // Header is rendered by panel.js via renderHomeHeader — preserve it.
    // Only clear content that we previously created.
    $pane.find("#rst-home-content").remove();

    const $content = $('<div id="rst-home-content"></div>');

    $content.append(`
        <div class="rst-sidecar-cadence" id="rst-sidecar-cadence" data-status="ready" title="Sidecar cadence status">
            <span class="rst-sidecar-cadence-dot">●</span>
            <span id="rst-sidecar-cadence-text">Sidecar cadence status unavailable.</span>
        </div>
    `);

    const pending = getPendingUpdates();
    if (pending) {
        renderPendingSection($content, pending);
    } else {
        renderNoPending($content);
    }

    renderPresentCharacters($content);
    $pane.append($content);
    refreshSidecarCadenceDisplay();
}

/**
 * Refresh only the pending section (without full re-render).
 * @param {jQuery} $pane
 */
export function refreshPending($pane) {
    refreshHomeHeaderStatus();

    // Always append inside #rst-home-content (same container renderHomeTab uses)
    // to prevent orphaned sections from accumulating outside the content div.
    const $container = $pane.find("#rst-home-content");
    const $target = $container.length ? $container : $pane;

    const $pendingSection = $target.find("#rst-pending-section");
    if ($pendingSection.length) {
        $pendingSection.remove();
    }

    const $noPending = $target.find("#rst-no-pending");
    if ($noPending.length) {
        $noPending.remove();
    }

    const pending = getPendingUpdates();
    if (pending) {
        renderPendingSection($target, pending);
    } else {
        renderNoPending($target);
    }
}

// Scene begin/end/delete can happen from message buttons or the Scenes tab
// without rebuilding Home. Keep both the persistent header and the Home notice
// synchronized from one lightweight lifecycle event.
$(document).on("rst:scene-state-changed", () => refreshPending($("#rst-p-home")));

// ─── Pending Updates Section ──────────────────────────────

function pendingUpdateScore(update) {
    if (!update) return -1;
    let score = 0;
    const changeCount = Number(update.changeCount || 0);
    if (changeCount > 0) score += 1000 + changeCount;
    if (String(update.source || "").includes("initial")) score += 100;
    if (update.statsAfter && typeof update.statsAfter === "object") score += 50;
    if (update.commentary && typeof update.commentary === "object") score += 25;
    if (update.dynamicTitleAfter) score += 10;
    if (update.narrativeSummary) score += 10;
    if (Array.isArray(update.proposedMilestones) && update.proposedMilestones.length) score += 8;
    if (Array.isArray(update.proposedConditions) && update.proposedConditions.length) score += 8;
    if (Array.isArray(update.resolvedConditions) && update.resolvedConditions.length) score += 8;
    if (Array.isArray(update.proposedHardLocks) && update.proposedHardLocks.length) score += 6;
    if (Array.isArray(update.proposedSoftLocks) && update.proposedSoftLocks.length) score += 6;
    if (Array.isArray(update.hardLockPressureUpdates) && update.hardLockPressureUpdates.length) score += 6;
    if (Array.isArray(update.hardLockReviews) && update.hardLockReviews.length) score += 6;
    if (Array.isArray(update.raisedCaps) && update.raisedCaps.length) score += 6;
    if (Array.isArray(update.unlockedSoftLocks) && update.unlockedSoftLocks.length) score += 6;
    if (Array.isArray(update.softLockProgress) && update.softLockProgress.length) score += 4;
    return score;
}

function normalizePendingCharacterUpdates(pending) {
    if (!pending || !Array.isArray(pending.characterUpdates)) return pending;

    const byId = new Map();
    const order = [];
    let changed = false;

    for (const update of pending.characterUpdates) {
        const profile = update?.characterId ? getCharacterProfile(update.characterId) : null;
        if (!update || !update.characterId || !isMeaningfulCharacterUpdate(update, profile)) {
            changed = true;
            if (update?.characterId && (pending.autoCreatedIds || []).includes(update.characterId)) {
                deleteCharacterData(update.characterId);
                pending.autoCreatedIds = pending.autoCreatedIds.filter((id) => id !== update.characterId);
            }
            continue;
        }
        const prev = byId.get(update.characterId);
        if (!prev) {
            byId.set(update.characterId, update);
            order.push(update.characterId);
            continue;
        }

        changed = true;
        const chosen = pendingUpdateScore(update) > pendingUpdateScore(prev) ? update : prev;
        byId.set(update.characterId, chosen);
        dlog(`[RST] Collapsed duplicate pending card for ${chosen.characterName || chosen.characterId}.`);
    }

    const normalized = order.map((id) => byId.get(id)).filter(Boolean);
    if (!changed && normalized.length === pending.characterUpdates.length) return pending;

    pending.characterUpdates = normalized;
    settlePendingAfterDecision(pending);
    return pending;
}

/**
 * Render the pending updates section.
 * @param {jQuery} $pane
 * @param {object} pending - The pending updates object
 */
function renderPendingSection($pane, pending) {
    pending = normalizePendingCharacterUpdates(pending);
    const scene = getSceneById(pending.sceneId);
    const sceneLabel = scene ? `Scene ${scene.id.replace("scene_", "")} just closed` : "Scene closed";

    const $section = $(`<div id="rst-pending-section"></div>`);

    // Label with badge
    $section.append(`
        <div class="rst-lbl">
            Pending updates
            <span class="rst-badge-pending" style="text-transform:none;letter-spacing:0;font-weight:400;margin-left:6px">${escapeHtml(sceneLabel)}</span>
        </div>
    `);

    // Scene summary has its own independent approval lifecycle. Once resolved,
    // its card disappears while any remaining character cards stay pending.
    if (!pending.summaryResolved) renderSceneSummaryCard($section, pending);

    // Per-character pending updates. Structural relationship changes (locks,
    // milestones, conditions) remain reviewable even when the numeric matrix
    // itself did not move.
    if (pending.characterUpdates) {
        const meaningfulUpdates = pending.characterUpdates.filter((update) => isMeaningfulCharacterUpdate(update, getCharacterProfile(update.characterId)));
        if (meaningfulUpdates.length === 0) {
            $section.append(`<div style="font-size:12px;color:var(--rst-text-muted);padding:12px 0">No relationship changes detected for any characters.</div>`);
        } else {
            for (const charUpdate of meaningfulUpdates) {
                renderCharacterPending($section, charUpdate, pending.sceneId);
            }
        }
    }

    // Approve All / Dismiss All buttons
    const $globalBtns = $(`
        <div class="rst-btn-row" style="margin-bottom:16px">
            <button class="rst-btn-approve" style="font-size:13px;padding:7px 16px" id="rst-approve-all">Approve all</button>
            <button class="rst-btn-danger" id="rst-dismiss-all">Dismiss all</button>
        </div>
    `);

    $globalBtns.find("#rst-approve-all").on("click", async () => {
    const rstScope1 = captureChatScope();

        await rstScope1.wait(() => (approveAllPending(pending)));
    });

    $globalBtns.find("#rst-dismiss-all").on("click", () => {
        dismissAllPending();
    });

    $section.append($globalBtns);
    $section.append('<hr class="rst-div">');

    $pane.append($section);
}

/**
 * Render the scene summary pending card.
 * @param {jQuery} $container
 * @param {object} pending
 */
function renderSceneSummaryCard($container, pending) {
    const $card = $(`<div class="rst-pending-card"></div>`);
    $card.append(`<div style="font-size:12px;font-weight:500;margin-bottom:8px;color:var(--rst-text-muted)">
        <span>Proposed scene summary</span>
        <i class="editor_maximize fa-solid fa-maximize right_menu_button" data-for="rst-edit-scene-summary" title="Expand the editor"></i>
    </div>`);

    const $textarea = $(`<textarea id="rst-edit-scene-summary" rows="3" style="margin-bottom:8px">${escapeHtml(pending.sceneSummary || "")}</textarea>`);
    $card.append($textarea);

    const $btnRow = $(`
        <div class="rst-btn-row" style="margin-bottom:6px">
            <button class="rst-btn-approve">Approve summary</button>
            <button class="rst-btn-danger rst-dismiss-summary">Dismiss summary</button>
            <button class="rst-btn rst-regen-toggle">Regenerate</button>
        </div>
    `);

    const $regenBox = renderRegenBox("regen-summary", async (guidance) => {
    const rstScope2 = captureChatScope();

        await rstScope2.wait(() => (regenerateSceneSummary(pending.sceneId, guidance)));
    });

    $btnRow.find(".rst-regen-toggle").on("click", () => {
        $regenBox.toggleClass("open");
    });

    $btnRow.find(".rst-btn-approve").on("click", () => {
        const summary = $textarea.val();
        if (!approveSceneSummary(pending, summary)) return;
        toastr?.success?.("Scene summary approved and saved.");
        refreshPending(getPane("home"));
        renderScenesTab(getPane("scenes"));
    });

    $btnRow.find(".rst-dismiss-summary").on("click", () => {
        if (!dismissSceneSummaryProposal(pending)) return;
        toastr?.info?.("Proposed scene summary dismissed.");
        refreshPending(getPane("home"));
    });

    $card.append($btnRow);
    $card.append($regenBox);
    $container.append($card);
}

/**
 * Render a single character's pending update block.
 * @param {jQuery} $container
 * @param {object} charUpdate
 * @param {string} sceneId
 */
function renderCharacterPending($container, charUpdate, sceneId) {
    const profile = getCharacterProfile(charUpdate.characterId);
    const displayName = charUpdate.characterName || profile?.name || "Unknown";
    const initials = getInitials(displayName);
    const changeCount = charUpdate.changeCount || 0;

    const $block = $(`<div class="rst-char-pending open"></div>`);

    // Header
    const $header = $(`
        <div class="rst-char-pending-hdr">
            <div class="rst-av" style="width:28px;height:28px;font-size:11px">${escapeHtml(initials)}</div>
            <span style="font-weight:500">${escapeHtml(displayName)}</span>
            <span style="margin-left:auto;font-size:11px;color:var(--rst-text-muted)">${changeCount} stat changes</span>
            <span style="font-size:11px;color:var(--rst-text-muted);margin-left:8px">▾</span>
        </div>
    `);

    $header.on("click", () => {
        $block.toggleClass("open");
    });

    $block.append($header);

    // Body
    const $body = $('<div class="rst-char-pending-body"></div>');

    // Stat grid
    const $statGrid = $('<div class="rst-stat-grid" style="margin-bottom:10px"></div>');
    for (const cat of STAT_CATEGORIES) {
        $statGrid.append(renderStatCategory(cat, charUpdate, sceneId));
    }
    $body.append($statGrid);

    // Dynamic title
    if (charUpdate.dynamicTitleBefore && charUpdate.dynamicTitleAfter) {
        $body.append(
            `<div class="rst-dyn" style="margin-bottom:8px">${escapeHtml(charUpdate.dynamicTitleBefore)} → ${escapeHtml(charUpdate.dynamicTitleAfter)}</div>`
        );
    }

    // Narrative summary
    if (charUpdate.narrativeSummary) {
        $body.append(
            `<div class="rst-narr" style="margin-bottom:10px">${escapeHtml(charUpdate.narrativeSummary)}</div>`
        );
    }

    if (Array.isArray(charUpdate.proposedMilestones) && charUpdate.proposedMilestones.length) {
        const $msWrap = $('<div class="rst-pending-system"></div>');
        $msWrap.append('<div class="rst-pending-system-title"><i class="fa-solid fa-flag"></i> Relationship milestone</div>');
        for (const ms of charUpdate.proposedMilestones) {
            const $item = $('<div class="rst-pending-system-item"></div>');
            $item.append($('<div class="rst-pending-system-name"></div>').text(ms.title || "Milestone"));
            $item.append($('<div></div>').text(ms.description || ""));
            $msWrap.append($item);
        }
        $body.append($msWrap);
    }

    if ((Array.isArray(charUpdate.proposedConditions) && charUpdate.proposedConditions.length) || (Array.isArray(charUpdate.resolvedConditions) && charUpdate.resolvedConditions.length)) {
        const $condWrap = $('<div class="rst-pending-system"></div>');
        $condWrap.append('<div class="rst-pending-system-title"><i class="fa-solid fa-tags"></i> Temporary relationship conditions</div>');
        for (const condition of (charUpdate.proposedConditions || [])) {
            const def = getRelationshipConditionDefinition(condition.type);
            if (!def) continue;
            const $item = $('<div class="rst-pending-system-item"></div>');
            $item.append($('<div class="rst-pending-system-name"></div>').text(`Add: ${def.label}`));
            $item.append($('<div></div>').text(condition.reason || ""));
            $item.append($('<div class="rst-pending-system-resolution"></div>').text(`Resolves when: ${condition.resolution || ""}`));
            $condWrap.append($item);
        }
        for (const condition of (charUpdate.resolvedConditions || [])) {
            const prof = getCharacterProfile(charUpdate.characterId);
            const active = (prof?.relationshipConditions || []).find((c) => c.id === condition.id);
            const def = active ? getRelationshipConditionDefinition(active.type) : null;
            const $item = $('<div class="rst-pending-system-item"></div>');
            $item.append($('<div class="rst-pending-system-name"></div>').text(`Resolve: ${def?.label || condition.id}`));
            if (condition.reason) $item.append($('<div></div>').text(condition.reason));
            $condWrap.append($item);
        }
        $body.append($condWrap);
    }

    renderPendingLockChanges($body, charUpdate);

    // Action buttons
    const $btnRow = $(`
        <div class="rst-btn-row">
            <button class="rst-btn-approve">Approve changes</button>
            <button class="rst-btn rst-regen-toggle">Regenerate</button>
            <button class="rst-btn rst-edit-btn">Edit manually</button>
            <button class="rst-btn rst-btn-danger" style="margin-left:auto">Dismiss</button>
        </div>
    `);

    const $regenBox = renderRegenBox(`regen-${charUpdate.characterId}`, async (guidance) => {
    const rstScope3 = captureChatScope();

        await rstScope3.wait(() => (regenerateCharacterUpdate(sceneId, charUpdate.characterId, guidance)));
    });

    $btnRow.find(".rst-regen-toggle").on("click", () => {
        $regenBox.toggleClass("open");
    });

    $btnRow.find(".rst-btn-approve").on("click", async () => {
    const rstScope4 = captureChatScope();

        await rstScope4.wait(() => (approveCharacterUpdate(charUpdate, sceneId)));
    });

    $btnRow.find(".rst-edit-btn").on("click", () => {
        showEditStatsModal(charUpdate, sceneId);
    });

    $btnRow.find(".rst-btn-danger").on("click", () => {
        dismissCharacterUpdate(charUpdate);
    });

    $body.append($btnRow);
    $body.append($regenBox);
    $block.append($body);
    $container.append($block);
}

function renderPendingLockChanges($body, charUpdate) {
    const rows = [];
    const push = (title, detail = "") => rows.push({ title, detail });

    for (const item of (charUpdate.raisedCaps || [])) {
        push(`Critical cap breakthrough: ${item.stat}`, `Hard-lock cap ${item.from ?? "?"} → ${item.to ?? "?"}`);
    }
    for (const item of (charUpdate.proposedHardLocks || [])) {
        push(`Proposed hard lock: ${item.stat}`, `Cap ${item.cap}${item.reason ? ` — ${item.reason}` : ""}`);
    }
    for (const item of (charUpdate.proposedSoftLocks || [])) {
        push(`Proposed soft lock: ${item.stat}`, `Cap ${item.cap}${item.condition ? ` — unlock when: ${item.condition}` : ""}${item.progress ? ` · Progress: ${item.progress}` : ""}`);
    }
    for (const stat of (charUpdate.unlockedSoftLocks || [])) {
        push(`Resolve soft lock: ${stat}`, "Its narrative condition was met in this scene.");
    }
    for (const item of (charUpdate.softLockProgress || [])) {
        push(`Soft-lock progress: ${item.stat}`, item.progress || "Progress updated.");
    }
    for (const item of (charUpdate.hardLockPressureUpdates || [])) {
        const change = Number(item.change || 0);
        push(`Hard-lock pressure: ${item.stat} ${change > 0 ? "+" : ""}${change}`, item.reason || "Pressure evidence updated.");
    }
    for (const item of (charUpdate.hardLockReviews || [])) {
        const cap = Number.isFinite(item.recommendedCap) ? ` · Suggested cap ${item.recommendedCap}` : "";
        push(`Hard-lock review: ${item.stat}`, `${item.recommendation || "review"}${cap}${item.reason ? ` — ${item.reason}` : ""}`);
    }

    if (!rows.length) return;

    const $wrap = $('<div class="rst-pending-system"></div>');
    $wrap.append('<div class="rst-pending-system-title"><i class="fa-solid fa-lock"></i> Lock changes</div>');
    for (const row of rows) {
        const $item = $('<div class="rst-pending-system-item"></div>');
        $item.append($('<div class="rst-pending-system-name"></div>').text(row.title));
        if (row.detail) $item.append($('<div></div>').text(row.detail));
        $wrap.append($item);
    }
    $wrap.append('<div class="rst-pending-system-resolution">Lock changes applied with approval.</div>');
    $body.append($wrap);
}

// ─── Stat Category Rendering ──────────────────────────────

/**
 * Render a stat category accordion block.
 * @param {string} cat - Category name (platonic, romantic, sexual)
 * @param {object} charUpdate
 * @returns {jQuery}
 */
function renderStatCategory(cat, charUpdate, sceneId) {
    const catTitle = cat.charAt(0).toUpperCase() + cat.slice(1);
    const $cat = $(`<div class="rst-stat-cat open"></div>`);
    $cat.append(`<div class="rst-sct">${catTitle} <span style="font-weight:400;font-size:10px">▾</span></div>`);

    for (const stat of STAT_NAMES) {
        const before = charUpdate.statsBefore?.[cat]?.[stat] ?? 0;
        const after = charUpdate.statsAfter?.[cat]?.[stat] ?? 0;
        const commentary = charUpdate.commentary?.[cat]?.[stat] || "";

        const beforeClass = getValueClass(before);
        const afterClass = getValueClass(after);

        // Show before→after if pending, or just the value
        const isPending = charUpdate.statsBefore !== undefined;
        const display = isPending
            ? `<span class="rst-sv ${beforeClass}">${formatPercent(before)}</span> → <span class="rst-sv ${afterClass}">${formatPercent(after)}</span>`
            : `<span class="rst-sv ${afterClass}">${formatPercent(after)}</span>`;

        const statKey = cat + "." + stat;
        const isCritical = Array.isArray(charUpdate.criticalStats) && charUpdate.criticalStats.includes(statKey);
        const critBadge = isCritical ? ' <span class="rst-crit-badge"><i class="fa-solid fa-bolt"></i> critical</span>' : '';
        $cat.append(`
            <div class="rst-sr">
                <span class="rst-sn">${stat.charAt(0).toUpperCase() + stat.slice(1)}${critBadge}</span>
                <span>${display}</span>
            </div>
            <div class="rst-sc">${escapeHtml(commentary)}</div>
        `);
    }

    $cat.on("click", function (e) {
        if ($(e.target).hasClass("rst-sct") || $(e.target).closest(".rst-sct").length) {
            $(this).toggleClass("open");
        }
    });

    return $cat;
}

// ─── Regeneration Box ─────────────────────────────────────

/**
 * Render a regeneration guidance box.
 * @param {string} id - Unique ID for the regen box
 * @param {Function} onRegenerate - Called with the guidance text
 * @returns {jQuery}
 */
function renderRegenBox(id, onRegenerate) {
    const $box = $(`
        <div class="rst-regen-box" id="rst-${id}">
            <div style="font-size:11px;color:var(--rst-text-muted);margin-bottom:6px">Optional — add guidance or leave blank to regenerate from scene alone</div>
            <textarea rows="2" style="margin-bottom:8px" placeholder="e.g. Focus more on the emotional subtext between them..."></textarea>
            <div class="rst-btn-row">
                <button class="rst-btn rst-regen-with-prompt">Regenerate with prompt</button>
                <button class="rst-btn rst-regen-from-scene">Regenerate from scene</button>
            </div>
        </div>
    `);

    $box.find(".rst-regen-with-prompt").on("click", async function () {
    const rstScope5 = captureChatScope();

        const guidance = $box.find("textarea").val().trim();
        await rstScope5.wait(() => (onRegenerate(guidance)));
    });

    $box.find(".rst-regen-from-scene").on("click", async function () {
    const rstScope6 = captureChatScope();

        await rstScope6.wait(() => (onRegenerate("")));
    });

    return $box;
}

// ─── Present Characters Section ───────────────────────────

/**
 * Render the "Characters currently present" section.
 * @param {jQuery} $pane
 */
function renderPresentCharacters($pane) {
    const $section = $(`<div id="rst-present-section"></div>`);
    const $secHdr = $(`
        <div class="rst-sec-h">
            <span class="rst-sec-title">Currently present</span>
            <span class="rst-sec-count" id="rst-present-count">0</span>
            <div class="rst-sec-line"></div>
        </div>
    `);
    $section.append($secHdr);

    // Card container
    const $chipContainer = $(`<div id="rst-present-chips" class="rst-present-grid"></div>`);
    $section.append($chipContainer);

    function renderChips() {
        $chipContainer.empty();
        const presentIds = getPresentCharacters();

        $("#rst-present-count").text(presentIds.length);

        if (presentIds.length === 0) {
            $chipContainer.append(
                '<div class="rst-empty">No characters detected in the current context.</div>'
            );
            return;
        }

        for (const charId of presentIds) {
            const profile = getCharacterProfile(charId);
            if (!profile) continue;

            const initials = getInitials(profile.name);
            let avContent = initials;
            if (profile.avatar) { avContent = `<img src="${escapeHtml(profile.avatar)}" alt="">`; }
            const dyn = profile.dynamicTitle || "No dynamic yet";
            const topStat = (cat) => {
                const stats = profile.stats?.[cat] || {};
                let best = 0;
                for (const k of STAT_NAMES) { const v = stats[k] ?? 0; if (Math.abs(v) > Math.abs(best)) best = v; }
                return best;
            };
            const plat = topStat("platonic"), rom = topStat("romantic"), sex = topStat("sexual");
            const $chip = $(`
                <div class="rst-pcard" style="cursor:pointer">
                    <div class="rst-av">${avContent}</div>
                    <div class="rst-pinfo">
                        <div class="rst-pname">${escapeHtml(profile.name)}</div>
                        <div class="rst-pdyn">${escapeHtml(dyn)}</div>
                    </div>
                    <div class="rst-pstat">
                        <div class="rst-pstat-item"><div class="rst-pstat-val ${getValueClass(plat)}">${plat}%</div><div class="rst-pstat-lbl">Plat</div></div>
                        <div class="rst-pstat-item"><div class="rst-pstat-val ${getValueClass(rom)}">${rom}%</div><div class="rst-pstat-lbl">Rom</div></div>
                        <div class="rst-pstat-item"><div class="rst-pstat-val ${getValueClass(sex)}">${sex}%</div><div class="rst-pstat-lbl">Sex</div></div>
                    </div>
                    <span class="rst-present-remove" data-char-id="${escapeHtml(charId)}" title="Remove from presence"><i class="fa-solid fa-xmark"></i></span>
                </div>
            `);

            // Click on chip opens library tab
            $chip.on("click", () => {
                switchTab("lib");
                $(document).trigger("rst:select-character", [charId]);
            });

            // Click on remove button removes character from presence
            $chip.find(".rst-present-remove").on("click", async (e) => {
    const rstScope7 = captureChatScope();

                e.preventDefault();
                e.stopPropagation();

                // Use currentTarget, not target. The user usually clicks the nested
                // <i> icon inside the span; e.target is then the icon, which does
                // not carry data-char-id and made removal a no-op.
                const idToRemove = $(e.currentTarget).attr("data-char-id");
                if (!idToRemove) return;

                const filtered = getPresentCharacters().filter((id) => id !== idToRemove);
                savePresentCharacters(filtered);
                const { updateInjection } = await rstScope7.wait(() => (import("../inject/promptInjector.js")));
                updateInjection();
                renderChips();
                populateAddDropdown();
            });

            $chipContainer.append($chip);
        }
    }

    // Add character row — same pattern as Scenes tab
    const $addRow = $(`
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
            <select id="rst-present-add-select" style="flex:1;font-size:12px;padding:4px 6px;border:0.5px solid var(--rst-border);border-radius:6px;background:transparent;color:inherit">
                <option value="">— Add character —</option>
            </select>
            <button id="rst-present-add-btn" class="rst-btn" style="font-size:11px;padding:3px 10px" disabled>+</button>
        </div>
    `);
    const $addSelect = $addRow.find("#rst-present-add-select");
    const $addBtn = $addRow.find("#rst-present-add-btn");

    function populateAddDropdown() {
        const currentIds = getPresentCharacters();
        const allChars = getAllCharacters();
        const available = allChars.filter((c) => !currentIds.includes(c.id));
        $addSelect.find("option:not([value=''])").remove();
        for (const c of available) {
            $addSelect.append(`<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`);
        }
        $addSelect.val("");
        $addBtn.prop("disabled", true);
    }

    $addSelect.on("change", function () {
        $addBtn.prop("disabled", !$(this).val());
    });

    $addBtn.on("click", async () => {
    const rstScope8 = captureChatScope();

        const newId = $addSelect.val();
        if (!newId) return;
        const currentIds = getPresentCharacters();
        if (!currentIds.includes(newId)) {
            const updatedIds = [...currentIds, newId];
            savePresentCharacters(updatedIds);
            const { updateInjection } = await rstScope8.wait(() => (import("../inject/promptInjector.js")));
            updateInjection();
            renderChips();
            populateAddDropdown();
        }
    });

    renderChips();
    populateAddDropdown();

    $section.append($addRow);

    const $libBtn = $('<button class="rst-btn">Open character library</button>');
    $libBtn.on("click", () => switchTab("lib"));
    $section.append($libBtn);

    $pane.append($section);
}

// ─── No Pending State ─────────────────────────────────────

/**
 * Render a "no pending updates" message.
 * @param {jQuery} $pane
 */
function renderNoPending($pane) {
    const openScene = getOpenScene();
    let message = "No pending updates.";

    if (openScene) {
        message = `Scene ${openScene.id.replace("scene_", "")} is currently open. Close it to generate stat updates.`;
    }

    $pane.append(`
        <div id="rst-no-pending" style="font-size:12px;color:var(--rst-text-muted);margin-bottom:14px;line-height:1.5">${message}</div>
    `);
}

// ─── Approval Actions ─────────────────────────────────────

function settlePendingAfterDecision(pending) {
    if (!pending) return;
    const hasCharacters = Array.isArray(pending.characterUpdates) && pending.characterUpdates.length > 0;
    if (!hasCharacters && pending.summaryResolved) savePendingUpdates(null);
    else savePendingUpdates(pending);
}

function approveSceneSummary(pending, summary) {
    if (!pending || getPendingUpdates() !== pending || !pending.sceneId) return false;
    pending.sceneSummary = String(summary || "");
    pending.summaryResolved = true;
    pending.summaryApproved = true;
    updateSceneSummary(pending.sceneId, pending.sceneSummary);
    settlePendingAfterDecision(pending);
    return true;
}

function dismissSceneSummaryProposal(pending) {
    if (!pending || getPendingUpdates() !== pending) return false;
    pending.summaryResolved = true;
    pending.summaryApproved = false;
    settlePendingAfterDecision(pending);
    return true;
}

/**
 * Approve a single character's pending update.
 * @param {object} charUpdate
 */
function approveCharacterUpdate(charUpdate, sceneId) {
    dlog("[RST] Approving update for:", charUpdate.characterName, { sceneId, statsBefore: charUpdate.statsBefore, statsAfter: charUpdate.statsAfter, commentary: charUpdate.commentary });
    try {
        if (!isMeaningfulCharacterUpdate(charUpdate, getCharacterProfile(charUpdate?.characterId))) {
            throw new Error("No relationship changes to approve.");
        }

        commitCharacterUpdate(charUpdate, sceneId);

        // Remove from pending
        const pending = getPendingUpdates();
        if (pending && pending.characterUpdates) {
            pending.autoCreatedIds = (pending.autoCreatedIds || []).filter(id => id !== charUpdate.characterId);
            pending.characterUpdates = pending.characterUpdates.filter(
                (u) => u.characterId !== charUpdate.characterId
            );
            settlePendingAfterDecision(pending);
        }
        dlog("[RST] Removed from pending:", charUpdate.characterName);

        toastr?.success?.(`${charUpdate.characterName} stat changes approved and saved.`);

        // Refresh UI
        const $pane = $("#rst-p-home");
        refreshPending($pane);

        // Update injection

        updateInjection();
        return true;
    } catch (err) {
        console.error("[RST] Failed to approve changes:", err);
        toastr?.error?.(err.message || "Failed to save stat changes.");
        return false;
    }
}

/**
 * Approve all pending updates at once.
 * @param {object} pending
 */
function approveAllPending(pending) {
    if (!pending?.characterUpdates || getPendingUpdates() !== pending) return;
    if (!pending.summaryResolved) approveSceneSummary(pending, pending.sceneSummary || "");
    normalizePendingCharacterUpdates(pending);
    for (const charUpdate of [...pending.characterUpdates].filter((update) => isMeaningfulCharacterUpdate(update, getCharacterProfile(update.characterId)))) {
        if (!approveCharacterUpdate(charUpdate, pending.sceneId)) return;
    }
    toastr?.success?.("All stat changes approved and saved.");
}

/**
 * Dismiss all pending updates.
 */
function dismissAllPending() {
    const pending = getPendingUpdates();
    const preserveApprovedSummary = !!(pending?.summaryResolved && pending?.summaryApproved);

    // Delete any auto-created character profiles (tracked deterministically during generation)
    if (pending && pending.autoCreatedIds && pending.autoCreatedIds.length > 0) {
        for (const id of pending.autoCreatedIds) {
            deleteCharacterData(id);
        }
    }

    // An explicitly approved summary is durable. Dismissing the remaining stat
    // cards must not delete its closed scene or the saved summary.
    if (pending && pending.sceneId && !preserveApprovedSummary) {
        deleteScene(pending.sceneId);
    }

    savePendingUpdates(null);
    toastr?.info?.(preserveApprovedSummary
        ? "Remaining pending stat changes dismissed. Approved scene summary preserved."
        : "All pending stat changes dismissed. Scene removed.");

    const $pane = getPane("home");
    refreshPending($pane);

    // Also refresh the Scenes tab to reflect the deletion
    const $scenesPane = getPane("scenes");
    if ($scenesPane) {
        renderScenesTab($scenesPane);
    }

    // Also refresh the Library tab to remove blank characters from view
    const $libPane = getPane("lib");
    if ($libPane) {
        renderLibraryTab($libPane);
    }
}

/**
 * Dismiss a single character's pending update.
 * Also cleans up auto-created character profiles to prevent blank characters in the Library.
 * @param {object} charUpdate
 */
function dismissCharacterUpdate(charUpdate) {
    const pending = getPendingUpdates();
    if (!pending || !pending.characterUpdates) return;

    // If this character was auto-created during generation, delete its profile
    // to prevent blank characters in the Library
    if (pending.autoCreatedIds && pending.autoCreatedIds.includes(charUpdate.characterId)) {
        deleteCharacterData(charUpdate.characterId);
    }

    pending.characterUpdates = pending.characterUpdates.filter(
        (u) => u.characterId !== charUpdate.characterId
    );

    settlePendingAfterDecision(pending);

    toastr?.info?.(`${charUpdate.characterName || "Character"} stats dismissed.`);

    const $pane = getPane("home");
    refreshPending($pane);

    // Also refresh the Library tab to remove blank character from view
    const $libPane = getPane("lib");
    if ($libPane) {
        renderLibraryTab($libPane);
    }
}

// ─── Regeneration Actions ─────────────────────────────────

/**
 * Regenerate the scene summary.
 * @param {string} sceneId
 * @param {string} guidance
 */
async function regenerateSceneSummary(sceneId, guidance) {
    const rstScope9 = captureChatScope();

    showPanelLoading("Regenerating scene summary...");
    try {
        toastr?.info?.("Regenerating scene summary...");
        const result = await rstScope9.wait(() => (generateStatUpdate(sceneId, guidance)));

        const pending = getPendingUpdates();
        if (pending) {
            pending.sceneSummary = result.sceneSummary;
            savePendingUpdates(pending);
        }

        const $pane = $("#rst-p-home");
        refreshPending($pane);

        toastr?.success?.("Scene summary regenerated.");
    } catch (err) {
        console.error("[RST] Failed to regenerate summary:", err);
    } finally {
        hidePanelLoading();
    }
}

/**
 * Regenerate a specific character's stat update.
 * @param {string} sceneId
 * @param {string} characterId
 * @param {string} guidance
 */
async function regenerateCharacterUpdate(sceneId, characterId, guidance) {
    const rstScope10 = captureChatScope();

    showPanelLoading("Regenerating stat updates...");
    try {
        toastr?.info?.("Regenerating stat updates...");
        const result = await rstScope10.wait(() => (generateStatUpdate(sceneId, guidance)));

        const pending = getPendingUpdates();
        if (pending && result.characterUpdates) {
            // Replace only this character's update
            const newUpdate = result.characterUpdates.find((u) => u.characterId === characterId);
            if (newUpdate) {
                pending.characterUpdates = pending.characterUpdates.map((u) =>
                    u.characterId === characterId ? newUpdate : u
                );
            }

            // Append any LLM-discovered characters not already in pending
            const pendingIds = new Set(pending.characterUpdates.map((u) => u.characterId));
            for (const discovered of result.characterUpdates) {
                if (discovered.source?.startsWith("llm_discovered") && !pendingIds.has(discovered.characterId)) {
                    pending.characterUpdates.push(discovered);
                }
            }

            // Merge any newly discovered auto-created IDs into the pending list
            if (result.autoCreatedIds && result.autoCreatedIds.length > 0) {
                if (!pending.autoCreatedIds) {
                    pending.autoCreatedIds = [];
                }
                for (const id of result.autoCreatedIds) {
                    if (!pending.autoCreatedIds.includes(id)) {
                        pending.autoCreatedIds.push(id);
                    }
                }
            }

            savePendingUpdates(pending);
        }

        const $pane = getPane("home");
        refreshPending($pane);

        toastr?.success?.("Stat updates regenerated.");
    } catch (err) {
        console.error("[RST] Failed to regenerate stats:", err);
    } finally {
        hidePanelLoading();
    }
}

// ─── Edit Stats Modal ─────────────────────────────────────

/**
 * Open a modal for editing a character's pending stat update.
 * Allows editing all 12 stat values, dynamic title, narrative summary, and commentary.
 * @param {object} charUpdate - The character update object
 * @param {string} sceneId - The scene ID
 */
async function showEditStatsModal(charUpdate, sceneId) {
    const rstScope11 = captureChatScope();

    dlog("[RST] Opening edit modal for:", charUpdate.characterName, charUpdate);
    // Load character profile for editable fields
    const profile = getCharacterProfile(charUpdate.characterId) || {};
    const editedStats = JSON.parse(JSON.stringify(charUpdate.statsAfter || {}));
    let html = `<div style="max-height:70vh;overflow-y:auto;padding-right:4px">`;

    // ─── Character Profile Section ──────────────────────────────
    const currentName = profile.name || charUpdate.characterName || "";
    const currentDesc = profile.description || "";
    const currentNotes = profile.notes || "";

    html += `<div style="margin-bottom:14px">
        <div style="font-weight:500;font-size:13px;margin-bottom:8px;color:var(--rst-text);border-bottom:1px solid var(--rst-border);padding-bottom:4px">Character Profile</div>

        <div style="margin-bottom:8px">
            <div style="font-size:11px;color:var(--rst-text-muted);margin-bottom:3px">Name</div>
            <input type="text" id="rst-edit-name" value="${escapeHtml(currentName)}"
                style="width:100%;padding:5px 8px;font-size:12px;border:0.5px solid var(--rst-border);border-radius:6px;background:var(--rst-bg);color:var(--rst-text)">
        </div>

        <div style="margin-bottom:8px">
            <div style="font-size:11px;color:var(--rst-text-muted);margin-bottom:3px">
                <span>Description</span>
                <i class="editor_maximize fa-solid fa-maximize right_menu_button" data-for="rst-edit-description" title="Expand the editor"></i>
            </div>
            <textarea id="rst-edit-description" rows="2"
                style="width:100%;padding:5px 8px;font-size:12px;border:0.5px solid var(--rst-border);border-radius:6px;background:var(--rst-bg);color:var(--rst-text);resize:vertical">${escapeHtml(currentDesc)}</textarea>
        </div>

        <div style="margin-bottom:8px">
            <div style="font-size:11px;color:var(--rst-text-muted);margin-bottom:3px">
                <span>Notes</span>
                <i class="editor_maximize fa-solid fa-maximize right_menu_button" data-for="rst-edit-notes" title="Expand the editor"></i>
            </div>
            <textarea id="rst-edit-notes" rows="2"
                style="width:100%;padding:5px 8px;font-size:12px;border:0.5px solid var(--rst-border);border-radius:6px;background:var(--rst-bg);color:var(--rst-text);resize:vertical">${escapeHtml(currentNotes)}</textarea>
        </div>
    </div>`;

    // ─── Stat Editors ───────────────────────────────────────────
    for (const cat of STAT_CATEGORIES) {
        const catTitle = cat.charAt(0).toUpperCase() + cat.slice(1);
        html += `<div style="margin-bottom:14px">
            <div style="font-weight:500;font-size:13px;margin-bottom:6px;color:var(--rst-text)">${catTitle}</div>`;

        for (const stat of STAT_NAMES) {
            const statTitle = stat.charAt(0).toUpperCase() + stat.slice(1);
            const beforeVal = charUpdate.statsBefore?.[cat]?.[stat] ?? 0;
            const currentVal = editedStats[cat]?.[stat] ?? 0;
            html += `
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
                    <label style="width:80px;font-size:12px;color:var(--rst-text-muted);flex-shrink:0">${statTitle}</label>
                    <span style="font-size:11px;color:var(--rst-text-muted);width:60px;text-align:right">(${formatPercent(beforeVal)} →)</span>
                    <input type="number" class="rst-edit-stat" data-cat="${cat}" data-stat="${stat}"
                        value="${currentVal}" min="-100" max="100"
                        style="width:70px;padding:3px 6px;font-size:12px;border:0.5px solid var(--rst-border);border-radius:6px;background:var(--rst-bg);color:var(--rst-text);text-align:center">
                    <span style="font-size:11px;color:var(--rst-text-muted)">%</span>
                </div>`;
        }
        html += `</div>`;
    }

    // Commentary editor
    html += `<div style="margin-bottom:14px">
        <div style="font-weight:500;font-size:13px;margin-bottom:6px;color:var(--rst-text)">Commentary (why stats changed)</div>`;

    for (const cat of STAT_CATEGORIES) {
        const catTitle = cat.charAt(0).toUpperCase() + cat.slice(1);
        html += `<div style="margin-bottom:8px">
            <div style="font-size:11px;color:var(--rst-text-muted);margin-bottom:3px">${catTitle}</div>`;

        for (const stat of STAT_NAMES) {
            const statTitle = stat.charAt(0).toUpperCase() + stat.slice(1);
            const commentText = charUpdate.commentary?.[cat]?.[stat] || "";
            html += `
                <div style="margin-bottom:3px">
                    <label style="font-size:11px;color:var(--rst-text-muted);width:70px;display:inline-block">${statTitle}</label>
                    <input type="text" class="rst-edit-commentary" data-cat="${cat}" data-stat="${stat}"
                        value="${escapeHtml(commentText)}"
                        style="width:calc(100% - 80px);padding:3px 6px;font-size:11px;border:0.5px solid var(--rst-border);border-radius:6px;background:var(--rst-bg);color:var(--rst-text)">
                </div>`;
        }
        html += `</div>`;
    }
    html += `</div>`;

    // Dynamic title
    const editedTitle = charUpdate.dynamicTitleAfter || "";
    html += `<div style="margin-bottom:10px">
        <div style="font-weight:500;font-size:13px;margin-bottom:4px;color:var(--rst-text)">Dynamic Title</div>
        <input type="text" id="rst-edit-title" value="${escapeHtml(editedTitle)}"
            style="width:100%;padding:5px 8px;font-size:12px;border:0.5px solid var(--rst-border);border-radius:6px;background:var(--rst-bg);color:var(--rst-text)">
    </div>`;

    // Narrative summary
    const editedNarrative = charUpdate.narrativeSummary || "";
    html += `<div style="margin-bottom:10px">
        <div style="font-weight:500;font-size:13px;margin-bottom:4px;color:var(--rst-text)">
            <span>Narrative Summary</span>
            <i class="editor_maximize fa-solid fa-maximize right_menu_button" data-for="rst-edit-narrative" title="Expand the editor"></i>
        </div>
        <textarea id="rst-edit-narrative" rows="3"
            style="width:100%;padding:5px 8px;font-size:12px;border:0.5px solid var(--rst-border);border-radius:6px;background:var(--rst-bg);color:var(--rst-text);resize:vertical">${escapeHtml(editedNarrative)}</textarea>
    </div>`;

    html += `</div>`; // End scroll container

    // Use ST's Popup system — Popup API uses constructor options + custom button actions
    // IMPORTANT: DOM values must be read INSIDE the action callback (BEFORE the popup closes).
    // Reading after await popup.show() returns will get empty strings because the popup DOM
    // is removed by this.dlg.remove() in Popup.#hide() before show() resolves.
    try {
        const popup = new Popup(html, POPUP_TYPE.TEXT, "", {
            okButton: false, // Hide default OK button — using custom "Save changes" instead
            customButtons: [
                {
                    text: "Save changes",
                    result: POPUP_RESULT.AFFIRMATIVE,
                    action: () => {
    if (!rstScope11.isCurrent()) return;

                        dlog("[RST] Save changes clicked for:", charUpdate.characterName);
                        // Read all edited values from the DOM while it's still present
                        const newStats = JSON.parse(JSON.stringify(charUpdate.statsAfter || {}));
                        $(popup.dlg).find(".rst-edit-stat").each(function () {
    if (!rstScope11.isCurrent()) return;

                            const cat = $(this).data("cat");
                            const stat = $(this).data("stat");
                            const val = parseInt($(this).val(), 10);
                            if (!isNaN(val)) {
                                if (!newStats[cat]) newStats[cat] = {};
                                newStats[cat][stat] = Math.max(-100, Math.min(100, val));
                            }
                        });
                        dlog("[RST] Edited stats:", JSON.stringify(newStats));

                        const newCommentary = JSON.parse(JSON.stringify(charUpdate.commentary || {}));
                        $(popup.dlg).find(".rst-edit-commentary").each(function () {
    if (!rstScope11.isCurrent()) return;

                            const cat = $(this).data("cat");
                            const stat = $(this).data("stat");
                            if (!newCommentary[cat]) newCommentary[cat] = {};
                            newCommentary[cat][stat] = $(this).val() || "";
                        });
                        dlog("[RST] Edited commentary:", JSON.stringify(newCommentary));

                        const newTitle = $(popup.dlg).find("#rst-edit-title").val() || "";
                        const newNarrative = $(popup.dlg).find("#rst-edit-narrative").val() || "";
                        const newName = $(popup.dlg).find("#rst-edit-name").val() || "";
                        const newDesc = $(popup.dlg).find("#rst-edit-description").val() || "";
                        const newNotes = $(popup.dlg).find("#rst-edit-notes").val() || "";

                        // Save profile changes to character database
                        const profileChanges = {};
                        if (newName !== (profile.name || charUpdate.characterName || "")) profileChanges.name = newName;
                        if (newDesc !== (profile.description || "")) profileChanges.description = newDesc;
                        if (newNotes !== (profile.notes || "")) profileChanges.notes = newNotes;
                        if (Object.keys(profileChanges).length > 0) {
                            updateCharacterProfile(charUpdate.characterId, profileChanges);
                        }

                        // Apply to pending updates
                        const pending = getPendingUpdates();
                        if (pending && pending.characterUpdates) {
                            const update = pending.characterUpdates.find((u) => u.characterId === charUpdate.characterId);
                            if (update) {
                                update.statsAfter = newStats;
                                update.commentary = newCommentary;
                                update.dynamicTitleAfter = newTitle;
                                update.narrativeSummary = newNarrative;
                                if (profileChanges.name) {
                                    update.characterName = newName;
                                }
                                // Recalculate change count
                                let changeCount = 0;
                                for (const cat of STAT_CATEGORIES) {
                                    for (const stat of STAT_NAMES) {
                                        const before = update.statsBefore?.[cat]?.[stat] ?? 0;
                                        const after = newStats[cat]?.[stat] ?? 0;
                                        if (before !== after) changeCount++;
                                    }
                                }
                                update.changeCount = changeCount;
                                savePendingUpdates(pending);
                                dlog("[RST] Saved pending updates for:", newName, { statsAfter: newStats, commentary: newCommentary });

                                // Refresh the UI
                                const $pane = $("#rst-p-home");
                                refreshPending($pane);
                                toastr?.success?.(`${newName} stats and profile updated manually.`);
                            }
                        }
                    },
                },
                {
                    text: "Reset to LLM values",
                    action: () => {
    if (!rstScope11.isCurrent()) return;

                        // Reset profile fields
                        $(popup.dlg).find("#rst-edit-name").val(profile.name || charUpdate.characterName || "");
                        $(popup.dlg).find("#rst-edit-description").val(profile.description || "");
                        $(popup.dlg).find("#rst-edit-notes").val(profile.notes || "");
                        // Reset stat fields
                        const originalAfter = charUpdate.statsAfter || {};
                        $(popup.dlg).find(".rst-edit-stat").each(function () {
    if (!rstScope11.isCurrent()) return;

                            const cat = $(this).data("cat");
                            const stat = $(this).data("stat");
                            $(this).val(originalAfter[cat]?.[stat] ?? 0);
                        });
                        // Reset dynamic fields
                        $(popup.dlg).find("#rst-edit-title").val(charUpdate.dynamicTitleAfter || "");
                        $(popup.dlg).find("#rst-edit-narrative").val(charUpdate.narrativeSummary || "");
                        $(popup.dlg).find(".rst-edit-commentary").each(function () {
    if (!rstScope11.isCurrent()) return;

                            const cat = $(this).data("cat");
                            const stat = $(this).data("stat");
                            $(this).val(charUpdate.commentary?.[cat]?.[stat] || "");
                        });
                        return false; // Don't close popup
                    },
                },
            ],
        });

        // Show popup — all saving is handled inside the "Save changes" action callback
        await rstScope11.wait(() => (popup.show()));
    } catch (err) {
        console.error("[RST] Failed to open edit modal:", err);

        // Fallback: use ST Popup with custom button for JSON editing
        try {
            const fallbackHtml = `
                <h3>Edit stats for ${escapeHtml(charUpdate.characterName)}</h3>
                <p style="font-size:12px;color:var(--rst-text-muted);margin-bottom:8px">
                    Paste the modified JSON stats object below:
                </p>
                <textarea id="rst-fallback-edit" rows="10" style="width:100%;font-family:monospace;font-size:11px">${JSON.stringify(charUpdate.statsAfter, null, 2)}</textarea>
            `;
            const fallbackPopup = new Popup(fallbackHtml, POPUP_TYPE.TEXT, "", {
                okButton: false, // Hide default OK button — using custom "Save" instead
                customButtons: [
                    {
                        text: "Save",
                        result: POPUP_RESULT.AFFIRMATIVE,
                        action: () => {
    if (!rstScope11.isCurrent()) return;

                            dlog("[RST] Fallback save triggered for:", charUpdate.characterName);
                            const newVal = $(fallbackPopup.dlg).find("#rst-fallback-edit").val();
                            try {
                                const parsed = JSON.parse(newVal);
                                dlog("[RST] Fallback parsed stats:", JSON.stringify(parsed));
                                const pending = getPendingUpdates();
                                if (pending && pending.characterUpdates) {
                                    const update = pending.characterUpdates.find((u) => u.characterId === charUpdate.characterId);
                                    if (update) {
                                        update.statsAfter = parsed;
                                        savePendingUpdates(pending);
                                        dlog("[RST] Fallback saved for:", charUpdate.characterName, parsed);
                                        const $pane = $("#rst-p-home");
                                        refreshPending($pane);
                                        toastr?.success?.(charUpdate.characterName + " stats updated manually.");
                                    }
                                }
                            } catch {
                                toastr?.error?.("Invalid JSON. Changes discarded.");
                            }
                        },
                    },
                ],
            });

            // Show popup — saving handled inside action callback
            await rstScope11.wait(() => (fallbackPopup.show()));
        } catch (fallbackErr) {
            console.error("[RST] Fallback edit modal also failed:", fallbackErr);
            toastr?.error?.("Could not open edit modal. Please try again.");
        }
    }
}

// ─── Helpers ──────────────────────────────────────────────

/**
 * Format a stat value as a percentage string.
 * @param {number} val
 * @returns {string}
 */
function formatPercent(val) {
    return (val >= 0 ? "+" : "") + val + "%";
}

/**
 * Get the CSS class for a stat value.
 * @param {number} val
 * @returns {string} "p" (positive), "n" (negative), or "z" (zero)
 */
function getValueClass(val) {
    if (val > 0) return "p";
    if (val < 0) return "n";
    return "z";
}
