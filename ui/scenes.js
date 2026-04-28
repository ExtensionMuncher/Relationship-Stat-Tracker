/**
 * scenes.js — Scenes tab: scene list + summaries
 * Renders the Scenes tab with all scene entries and their summaries
 */

import { Popup } from "../../../../../scripts/popup.js";
import { getCharacterProfile, getInitials } from "../data/characters.js";
import { getAllScenes, getOpenScene, deleteScene, updateSceneSummary, updateSceneTitle, formatTimeAgo } from "../data/scenes.js";

// ─── Bulk Selection State ─────────────────────────────────

/** @type {Set<string>} Set of scene IDs selected for bulk operations */
const selectedScenes = new Set();

// ─── Main Render ──────────────────────────────────────────

/**
 * Render the full Scenes tab.
 * @param {jQuery} $pane
 */
export function renderScenesTab($pane) {
    selectedScenes.clear();
    $pane.empty();

    // Info box
    $pane.append(`
        <div class="rst-info-box">
            These scene summaries are private notes written by the stat LLM to maintain narrative continuity between sessions.
            They are never injected into your main ST prompt and will not be seen by your primary AI.
            They exist solely so the stat-updating model understands what happened before reviewing a new scene.
        </div>
    `);

    // Open scene (if any)
    const openScene = getOpenScene();
    if (openScene) {
        $pane.append('<div class="rst-lbl">Open scene</div>');
        $pane.append(renderSceneEntry(openScene, true));
    }

    // Closed scenes
    const allScenes = getAllScenes();
    const closedScenes = allScenes.filter((s) => s.status === "closed");

    if (closedScenes.length > 0) {
        $pane.append('<div class="rst-lbl">Closed scenes</div>');

        // Bulk action toolbar
        const $toolbar = $(`
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:6px 4px;border:0.5px solid var(--rst-border);border-radius:6px;background:var(--rst-bg-secondary, rgba(0,0,0,0.05))">
                <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer">
                    <input type="checkbox" id="rst-select-all-scenes" style="margin:0">
                    Select all
                </label>
                <button id="rst-delete-selected-scenes" class="rst-btn-danger" style="font-size:11px;padding:3px 10px;opacity:0.5;pointer-events:none" disabled>Delete selected (0)</button>
            </div>
        `);

        // Select all toggle
        $toolbar.find("#rst-select-all-scenes").on("change", function () {
            const checked = $(this).prop("checked");
            $pane.find(".rst-scene-select").prop("checked", checked).trigger("change");
        });

        // Delete selected handler
        $toolbar.find("#rst-delete-selected-scenes").on("click", async function () {
            const count = selectedScenes.size;
            if (count === 0) return;
            const confirmed = await Popup.show.confirm(
                "Delete Scenes",
                `Delete ${count} selected scene${count > 1 ? "s" : ""}? This cannot be undone.`
            );
            if (!confirmed) return;
            for (const sceneId of selectedScenes) {
                deleteScene(sceneId);
            }
            selectedScenes.clear();
            toastr?.info?.(`${count} scene${count > 1 ? "s" : ""} deleted.`);
            renderScenesTab($pane);
        });

        $pane.append($toolbar);

        for (const scene of closedScenes) {
            $pane.append(renderSceneEntry(scene, false));
        }
    }

    if (!openScene && closedScenes.length === 0) {
        $pane.append(`
            <div style="font-size:12px;color:var(--rst-text-muted);padding:6px 2px;line-height:1.5">
                No scenes recorded yet. Use the Scene Start/End buttons on message bars to create scenes.
            </div>
        `);
    }
}

// ─── Scene Entry Rendering ────────────────────────────────

/**
 * Render a single scene entry.
 * @param {object} scene
 * @param {boolean} isOpen - Whether this is the currently open scene
 * @returns {jQuery}
 */
function renderSceneEntry(scene, isOpen) {
    const sceneNum = scene.id.replace("scene_", "");
    const timeAgo = formatTimeAgo(scene.timestamp);
    const msgRange = scene.messageEnd !== null
        ? `Msgs ${scene.messageStart}–${scene.messageEnd} · ${timeAgo}`
        : `Msgs ${scene.messageStart}+ · ${timeAgo}`;

    // Get character names
    const charNames = (scene.charactersPresent || []).map((id) => {
        const profile = getCharacterProfile(id);
        return profile ? profile.name : id;
    });

    const sceneTitle = scene.title || "";

    const $entry = $(`<div class="rst-scene-entry${isOpen ? " open" : ""}"></div>`);

    // Header
    const $header = $(`
        <div class="rst-scene-hdr">
            ${isOpen ? "" : `<input type="checkbox" class="rst-scene-select" data-scene-id="${scene.id}" style="margin:0;cursor:pointer" title="Select this scene">`}
            <div>
                <div style="font-weight:500">Scene ${sceneNum}${sceneTitle ? ` — ${sceneTitle}` : ""}</div>
                <div style="font-size:11px;color:var(--rst-text-muted)">${msgRange}</div>
            </div>
            <div style="margin-left:auto;display:flex;gap:8px;align-items:center">
                <span style="font-size:11px;color:var(--rst-text-muted)">${charNames.join(", ")}</span>
                ${isOpen
                    ? '<span class="rst-badge-pending">open</span>'
                    : '<span class="rst-badge-closed">closed</span>'
                }
            </div>
        </div>
    `);

    // Wire up bulk selection checkbox (closed scenes only)
    if (!isOpen) {
        const $checkbox = $header.find(".rst-scene-select");
        $checkbox.on("change", function () {
            const checked = $(this).prop("checked");
            const sceneId = $(this).data("scene-id");
            if (checked) {
                selectedScenes.add(sceneId);
            } else {
                selectedScenes.delete(sceneId);
            }
            // Update bulk action toolbar state
            const $toolbar = $entry.closest("#rst-p-scenes").find("#rst-delete-selected-scenes");
            const count = selectedScenes.size;
            $toolbar.text(`Delete selected (${count})`);
            if (count > 0) {
                $toolbar.prop("disabled", false).css({ opacity: 1, pointerEvents: "auto" });
            } else {
                $toolbar.prop("disabled", true).css({ opacity: 0.5, pointerEvents: "none" });
            }
            // Uncheck "Select all" if not all selected
            const totalCheckboxes = $entry.closest("#rst-p-scenes").find(".rst-scene-select").length;
            const checkedCheckboxes = $entry.closest("#rst-p-scenes").find(".rst-scene-select:checked").length;
            const $selectAll = $entry.closest("#rst-p-scenes").find("#rst-select-all-scenes");
            $selectAll.prop("checked", totalCheckboxes > 0 && checkedCheckboxes === totalCheckboxes);
        });
    }

    // Click on header content (but not checkbox) toggles body
    $header.on("click", (e) => {
        if ($(e.target).is("input[type=checkbox]")) return;
        $entry.toggleClass("open");
    });

    $entry.append($header);

    // Body
    const $body = $('<div class="rst-scene-body"></div>');

    // Characters in this scene (always shown, for both open and closed)
    if (charNames.length > 0) {
        const $charSection = $(`
            <div style="margin-bottom:10px">
                <div class="rst-lbl" style="margin-bottom:6px">Characters in this scene</div>
                <div class="rst-btn-row" style="flex-wrap:wrap;gap:6px"></div>
            </div>
        `);

        const $chipContainer = $charSection.find(".rst-btn-row");
        for (let i = 0; i < charNames.length; i++) {
            const charId = scene.charactersPresent[i];
            const profile = getCharacterProfile(charId);
            const initials = getInitials(charNames[i]);
            const $chip = $(`
                <div style="display:flex;align-items:center;gap:5px;padding:4px 8px;border:0.5px solid var(--rst-border);border-radius:6px;font-size:12px">
                    <div class="rst-av" style="width:22px;height:22px;font-size:9px">${initials}</div>
                    <span>${charNames[i]}</span>
                </div>
            `);
            $chipContainer.append($chip);
        }

        $body.append($charSection);
    } else {
        $body.append(`
            <div style="font-size:11px;color:var(--rst-text-muted);margin-bottom:10px">No characters recorded for this scene.</div>
        `);
    }

    // Scene title editing (shown for both open and closed)
    $body.append(`
        <div style="display:flex;align-items:baseline;gap:6px;margin-bottom:6px">
            <div class="rst-lbl" style="margin-bottom:0">Scene Title</div>
            <span style="font-size:11px;color:var(--rst-text-muted)">optional — a name for this scene</span>
        </div>
    `);

    const $titleInput = $(`<input type="text" class="rst-scene-title-input" value="${sceneTitle}" placeholder="e.g. The Confrontation at the Gate">`);
    $titleInput.on("change", function () {
        updateSceneTitle(scene.id, $(this).val());
    });
    $body.append($titleInput);

    if (isOpen) {
        $body.append(`
            <div style="font-size:12px;color:var(--rst-text-muted);line-height:1.5;margin-top:10px">
                This scene is currently open. Close it to generate stat updates and a summary.
            </div>
        `);
    } else {
        // Summary
        $body.append(`
            <div style="display:flex;align-items:baseline;gap:6px;margin-bottom:6px;margin-top:10px">
                <div class="rst-lbl" style="margin-bottom:0">Summary</div>
                <span style="font-size:11px;color:var(--rst-text-muted)">editable</span>
            </div>
        `);

        const $textarea = $(`<textarea rows="4">${scene.llmSummary || ""}</textarea>`);
        $textarea.on("change", function () {
            updateSceneSummary(scene.id, $(this).val());
        });
        $body.append($textarea);
    }

    // Delete button (shown for both open and closed scenes)
    {
        const deleteLabel = isOpen
            ? "Delete scene (open — no stats will be generated)"
            : "Delete scene";
        const confirmMsg = isOpen
            ? `Delete open Scene ${sceneNum}? This scene has not been closed — no stat updates or summary will be generated. This cannot be undone.`
            : `Delete Scene ${sceneNum}? This cannot be undone.`;

        const $btnRow = $(`
            <div class="rst-btn-row" style="margin-top:8px">
                <button class="rst-btn-danger">${deleteLabel}</button>
            </div>
        `);

        $btnRow.find("button").on("click", async () => {
            const confirmed = await Popup.show.confirm("Delete Scene", confirmMsg);
            if (!confirmed) return;
            deleteScene(scene.id);
            toastr?.info?.(`Scene ${sceneNum} deleted.`);
            const $pane = $("#rst-p-scenes");
            renderScenesTab($pane);
        });

        $body.append($btnRow);
    }

    $entry.append($body);
    return $entry;
}
