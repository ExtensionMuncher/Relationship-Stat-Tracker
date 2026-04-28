/**
 * home.js — Home tab: toggle, pending updates, present characters
 * Renders the Home tab with pending update cards and present character list
 */

import { getPendingUpdates, savePendingUpdates, getPresentCharacters } from "../data/storage.js";
import { getCharacterProfile, getInitials, STAT_CATEGORIES, STAT_NAMES } from "../data/characters.js";
import { getOpenScene, getSceneById } from "../data/scenes.js";
import { generateStatUpdate } from "../llm/statUpdate.js";
import { switchTab } from "./panel.js";

// ─── Main Render ──────────────────────────────────────────

/**
 * Render the full Home tab content.
 * @param {jQuery} $pane
 */
export function renderHomeTab($pane) {
    // Header is rendered by panel.js via renderHomeHeader — preserve it.
    // Only clear content that we previously created.
    $pane.find("#rst-home-content").remove();

    const $content = $('<div id="rst-home-content"></div>');

    const pending = getPendingUpdates();
    if (pending) {
        renderPendingSection($content, pending);
    } else {
        renderNoPending($content);
    }

    renderPresentCharacters($content);
    $pane.append($content);
}

/**
 * Refresh only the pending section (without full re-render).
 * @param {jQuery} $pane
 */
export function refreshPending($pane) {
    const $pendingSection = $pane.find("#rst-pending-section");
    if ($pendingSection.length) {
        $pendingSection.remove();
    }

    const $noPending = $pane.find("#rst-no-pending");
    if ($noPending.length) {
        $noPending.remove();
    }

    const pending = getPendingUpdates();
    if (pending) {
        renderPendingSection($pane, pending);
    } else {
        renderNoPending($pane);
    }

    // Re-position before the present characters section
    const $presentSection = $pane.find("#rst-present-section");
    const $newContent = $pane.find("#rst-pending-section, #rst-no-pending");
    if ($presentSection.length && $newContent.length) {
        // Already in correct position
    }
}

// ─── Pending Updates Section ──────────────────────────────

/**
 * Render the pending updates section.
 * @param {jQuery} $pane
 * @param {object} pending - The pending updates object
 */
function renderPendingSection($pane, pending) {
    const scene = getSceneById(pending.sceneId);
    const sceneLabel = scene ? `Scene ${scene.id.replace("scene_", "")} just closed` : "Scene closed";

    const $section = $(`<div id="rst-pending-section"></div>`);

    // Label with badge
    $section.append(`
        <div class="rst-lbl">
            Pending updates
            <span class="rst-badge-pending" style="text-transform:none;letter-spacing:0;font-weight:400;margin-left:6px">${sceneLabel}</span>
        </div>
    `);

    // Scene summary card
    renderSceneSummaryCard($section, pending);

    // Per-character pending updates
    if (pending.characterUpdates) {
        for (const charUpdate of pending.characterUpdates) {
            renderCharacterPending($section, charUpdate, pending.sceneId);
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
        await approveAllPending(pending);
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
    $card.append('<div style="font-size:12px;font-weight:500;margin-bottom:8px;color:var(--rst-text-muted)">Proposed scene summary</div>');

    const $textarea = $(`<textarea rows="3" style="margin-bottom:8px">${pending.sceneSummary || ""}</textarea>`);
    $card.append($textarea);

    const $btnRow = $(`
        <div class="rst-btn-row" style="margin-bottom:6px">
            <button class="rst-btn-approve">Approve summary</button>
            <button class="rst-btn rst-regen-toggle">Regenerate</button>
        </div>
    `);

    const $regenBox = renderRegenBox("regen-summary", async (guidance) => {
        await regenerateSceneSummary(pending.sceneId, guidance);
    });

    $btnRow.find(".rst-regen-toggle").on("click", () => {
        $regenBox.toggleClass("open");
    });

    $btnRow.find(".rst-btn-approve").on("click", () => {
        pending.sceneSummary = $textarea.val();
        savePendingUpdates(pending);
        toastr?.success?.("Scene summary approved.");
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
            <div class="rst-av" style="width:28px;height:28px;font-size:11px">${initials}</div>
            <span style="font-weight:500">${displayName}</span>
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
        $statGrid.append(renderStatCategory(cat, charUpdate));
    }
    $body.append($statGrid);

    // Dynamic title
    if (charUpdate.dynamicTitleBefore && charUpdate.dynamicTitleAfter) {
        $body.append(
            `<div class="rst-dyn" style="margin-bottom:8px">${charUpdate.dynamicTitleBefore} → ${charUpdate.dynamicTitleAfter}</div>`
        );
    }

    // Narrative summary
    if (charUpdate.narrativeSummary) {
        $body.append(
            `<div class="rst-narr" style="margin-bottom:10px">${charUpdate.narrativeSummary}</div>`
        );
    }

    // Action buttons
    const $btnRow = $(`
        <div class="rst-btn-row">
            <button class="rst-btn-approve">Approve changes</button>
            <button class="rst-btn rst-regen-toggle">Regenerate</button>
            <button class="rst-btn rst-edit-btn">Edit manually</button>
        </div>
    `);

    const $regenBox = renderRegenBox(`regen-${charUpdate.characterId}`, async (guidance) => {
        await regenerateCharacterUpdate(sceneId, charUpdate.characterId, guidance);
    });

    $btnRow.find(".rst-regen-toggle").on("click", () => {
        $regenBox.toggleClass("open");
    });

    $btnRow.find(".rst-btn-approve").on("click", async () => {
        await approveCharacterUpdate(charUpdate);
    });

    $btnRow.find(".rst-edit-btn").on("click", () => {
        // TODO: Open inline editor for stat values
        toastr?.info?.("Manual editing coming soon.");
    });

    $body.append($btnRow);
    $body.append($regenBox);
    $block.append($body);
    $container.append($block);
}

// ─── Stat Category Rendering ──────────────────────────────

/**
 * Render a stat category accordion block.
 * @param {string} cat - Category name (platonic, romantic, sexual)
 * @param {object} charUpdate
 * @returns {jQuery}
 */
function renderStatCategory(cat, charUpdate) {
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

        $cat.append(`
            <div class="rst-sr">
                <span class="rst-sn">${stat.charAt(0).toUpperCase() + stat.slice(1)}</span>
                <span>${display}</span>
            </div>
            <div class="rst-sc">${commentary}</div>
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
        const guidance = $box.find("textarea").val().trim();
        await onRegenerate(guidance);
    });

    $box.find(".rst-regen-from-scene").on("click", async function () {
        await onRegenerate("");
    });

    return $box;
}

// ─── Present Characters Section ───────────────────────────

/**
 * Render the "Characters currently present" section.
 * @param {jQuery} $pane
 */
function renderPresentCharacters($pane) {
    const presentIds = getPresentCharacters();
    const $section = $(`<div id="rst-present-section"></div>`);
    $section.append('<div class="rst-lbl">Characters currently present</div>');

    if (presentIds.length === 0) {
        $section.append(
            '<div style="font-size:12px;color:var(--rst-text-muted);padding:6px 2px;margin-bottom:12px">No characters detected in current context.</div>'
        );
    } else {
        for (const charId of presentIds) {
            const profile = getCharacterProfile(charId);
            if (!profile) continue;

            const initials = getInitials(profile.name);
            const $chip = $(`
                <div class="rst-chip">
                    <div class="rst-dot"></div>
                    <div class="rst-av">${initials}</div>
                    <span style="font-weight:500">${profile.name}</span>
                    <span style="margin-left:auto;font-size:11px;color:var(--rst-text-muted)">view profile →</span>
                </div>
            `);

            $chip.on("click", () => {
                switchTab("lib");
                $(document).trigger("rst:select-character", [charId]);
            });

            $section.append($chip);
        }

        $section.append(
            '<div style="font-size:12px;color:var(--rst-text-muted);padding:6px 2px;margin-bottom:12px">No other characters detected in current context.</div>'
        );
    }

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

/**
 * Approve a single character's pending update.
 * @param {object} charUpdate
 */
async function approveCharacterUpdate(charUpdate) {
    try {
        const { updateCharacterStats, updateCharacterProfile, addUpdateLogEntry } = await import("../data/characters.js");
        const { updateSceneSummary } = await import("../data/scenes.js");

        // Commit stats
        updateCharacterStats(charUpdate.characterId, charUpdate.statsAfter);

        // Update dynamic title and narrative
        updateCharacterProfile(charUpdate.characterId, {
            dynamicTitle: charUpdate.dynamicTitleAfter,
            narrativeSummary: charUpdate.narrativeSummary,
        });

        // Create update log entry
        addUpdateLogEntry(charUpdate.characterId, {
            sceneId: charUpdate.sceneId || "",
            messageRange: { start: 0, end: 0 }, // Filled from scene data
            timestamp: Date.now(),
            statsBefore: charUpdate.statsBefore,
            statsAfter: charUpdate.statsAfter,
            commentary: charUpdate.commentary,
            dynamicTitleBefore: charUpdate.dynamicTitleBefore,
            dynamicTitleAfter: charUpdate.dynamicTitleAfter,
            narrativeSummary: charUpdate.narrativeSummary,
        });

        // Remove from pending
        const pending = getPendingUpdates();
        if (pending && pending.characterUpdates) {
            pending.characterUpdates = pending.characterUpdates.filter(
                (u) => u.characterId !== charUpdate.characterId
            );
            if (pending.characterUpdates.length === 0) {
                savePendingUpdates(null);
            } else {
                savePendingUpdates(pending);
            }
        }

        toastr?.success?.(`${charUpdate.characterName} stat changes approved and saved.`);

        // Refresh UI
        const $pane = $("#rst-p-home");
        refreshPending($pane);

        // Update injection
        const { updateInjection } = await import("../inject/promptInjector.js");
        updateInjection();
    } catch (err) {
        console.error("[RST] Failed to approve changes:", err);
        toastr?.error?.("Failed to save stat changes. Please try again.");
    }
}

/**
 * Approve all pending updates at once.
 * @param {object} pending
 */
async function approveAllPending(pending) {
    if (!pending || !pending.characterUpdates) return;

    for (const charUpdate of pending.characterUpdates) {
        await approveCharacterUpdate(charUpdate);
    }

    toastr?.success?.("All stat changes approved and saved.");
}

/**
 * Dismiss all pending updates.
 */
function dismissAllPending() {
    savePendingUpdates(null);
    toastr?.info?.("All pending stat changes dismissed.");

    const $pane = $("#rst-p-home");
    refreshPending($pane);
}

// ─── Regeneration Actions ─────────────────────────────────

/**
 * Regenerate the scene summary.
 * @param {string} sceneId
 * @param {string} guidance
 */
async function regenerateSceneSummary(sceneId, guidance) {
    try {
        toastr?.info?.("Regenerating scene summary...");
        const result = await generateStatUpdate(sceneId, guidance);

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
    }
}

/**
 * Regenerate a specific character's stat update.
 * @param {string} sceneId
 * @param {string} characterId
 * @param {string} guidance
 */
async function regenerateCharacterUpdate(sceneId, characterId, guidance) {
    try {
        toastr?.info?.("Regenerating stat updates...");
        const result = await generateStatUpdate(sceneId, guidance);

        const pending = getPendingUpdates();
        if (pending && result.characterUpdates) {
            // Replace only this character's update
            const newUpdate = result.characterUpdates.find((u) => u.characterId === characterId);
            if (newUpdate) {
                pending.characterUpdates = pending.characterUpdates.map((u) =>
                    u.characterId === characterId ? newUpdate : u
                );
                savePendingUpdates(pending);
            }
        }

        const $pane = $("#rst-p-home");
        refreshPending($pane);

        toastr?.success?.("Stat updates regenerated.");
    } catch (err) {
        console.error("[RST] Failed to regenerate stats:", err);
    }
}

// ─── Helpers ──────────────────────────────────────────────

/**
 * Format a stat value as a percentage string.
 * @param {number} val
 * @returns {string}
 */
function formatPercent(val) {
    return `${val >= 0 ? "" : ""}${val}%`;
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
