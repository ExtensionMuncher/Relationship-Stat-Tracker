/**
 * scenes.js — Scenes tab: scene list + summaries
 * Renders the Scenes tab with all scene entries and their summaries
 */

import { getCharacterProfile, getInitials } from "../data/characters.js";
import { getAllScenes, getOpenScene, deleteScene, updateSceneSummary, formatTimeAgo } from "../data/scenes.js";

// ─── Main Render ──────────────────────────────────────────

/**
 * Render the full Scenes tab.
 * @param {jQuery} $pane
 */
export function renderScenesTab($pane) {
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

    const $entry = $(`<div class="rst-scene-entry${isOpen ? " open" : ""}"></div>`);

    // Header
    const $header = $(`
        <div class="rst-scene-hdr">
            <div>
                <div style="font-weight:500">Scene ${sceneNum}</div>
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

    $header.on("click", () => {
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

    if (isOpen) {
        $body.append(`
            <div style="font-size:12px;color:var(--rst-text-muted);line-height:1.5">
                This scene is currently open. Close it to generate stat updates and a summary.
            </div>
        `);
    } else {
        // Summary
        $body.append(`
            <div style="display:flex;align-items:baseline;gap:6px;margin-bottom:6px">
                <div class="rst-lbl" style="margin-bottom:0">Summary</div>
                <span style="font-size:11px;color:var(--rst-text-muted)">editable</span>
            </div>
        `);

        const $textarea = $(`<textarea rows="4">${scene.llmSummary || ""}</textarea>`);
        $textarea.on("change", function () {
            updateSceneSummary(scene.id, $(this).val());
        });
        $body.append($textarea);

        // Delete button
        const $btnRow = $(`
            <div class="rst-btn-row" style="margin-top:8px">
                <button class="rst-btn-danger">Delete scene</button>
            </div>
        `);

        $btnRow.find("button").on("click", () => {
            if (confirm(`Delete Scene ${sceneNum}? This cannot be undone.`)) {
                deleteScene(scene.id);
                toastr?.info?.(`Scene ${sceneNum} deleted.`);
                const $pane = $("#rst-p-scenes");
                renderScenesTab($pane);
            }
        });

        $body.append($btnRow);
    }

    $entry.append($body);
    return $entry;
}
