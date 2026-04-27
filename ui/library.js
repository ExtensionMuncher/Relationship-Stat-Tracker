/**
 * library.js — Character Library tab: list, display, wand, logs
 * Renders the character library with full stat display, update logs, and profile generation
 */

import { getPresentCharacters } from "../data/storage.js";
import {
    getAllCharacters,
    getCharacterProfile,
    getInitials,
    createCharacter,
    deleteCharacter,
    updateCharacterProfile,
    updateCharacterStats,
    removeUpdateLogEntry,
    exportCharacters,
    importCharacters,
    STAT_CATEGORIES,
    STAT_NAMES,
} from "../data/characters.js";
import { generateProfile } from "../llm/profileGen.js";
import { formatTimeAgo } from "../data/scenes.js";

// ─── State ────────────────────────────────────────────────

let selectedCharId = null;

// ─── Main Render ──────────────────────────────────────────

/**
 * Render the full Character Library tab.
 * @param {jQuery} $pane
 */
export function renderLibraryTab($pane) {
    $pane.empty();

    // Action buttons
    const $btnRow = $(`
        <div class="rst-btn-row" style="margin-bottom:12px">
            <button class="rst-btn" id="rst-new-char">+ New character</button>
            <button class="rst-btn" id="rst-import-chars">Import</button>
            <button class="rst-btn" id="rst-export-chars">Export</button>
        </div>
    `);

    $btnRow.find("#rst-new-char").on("click", () => showNewCharacterDialog($pane));
    $btnRow.find("#rst-export-chars").on("click", () => downloadExport());
    $btnRow.find("#rst-import-chars").on("click", () => triggerImport());

    $pane.append($btnRow);

    // Character chips
    renderCharacterChips($pane);

    // Divider
    $pane.append('<hr class="rst-div">');

    // Character display
    $pane.append('<div class="rst-lbl">Character display</div>');

    if (selectedCharId) {
        const profile = getCharacterProfile(selectedCharId);
        if (profile) {
            renderCharacterCard($pane, profile);
        } else {
            selectedCharId = null;
            $pane.append('<div style="font-size:12px;color:var(--rst-text-muted)">Select a character above to view details.</div>');
        }
    } else {
        $pane.append('<div style="font-size:12px;color:var(--rst-text-muted)">Select a character above to view details.</div>');
    }

    // Hidden modals
    $pane.append('<div id="rst-wand-wrap" style="display:none;margin-top:8px"></div>');
    $pane.append('<div id="rst-log-wrap" style="display:none;margin-top:4px"></div>');
    $pane.append('<div id="rst-newchar-wrap" style="display:none;margin-top:8px"></div>');
}

/**
 * Select a specific character by ID.
 * @param {string} charId
 */
export function selectCharacter(charId) {
    selectedCharId = charId;
    const $pane = $("#rst-p-lib");
    renderLibraryTab($pane);
}

// ─── Character Chips ──────────────────────────────────────

/**
 * Render the character chip list.
 * @param {jQuery} $pane
 */
function renderCharacterChips($pane) {
    const chars = getAllCharacters();
    const presentIds = getPresentCharacters();

    for (const char of chars) {
        const initials = getInitials(char.name);
        const isPresent = presentIds.includes(char.id);
        const isSelected = char.id === selectedCharId;

        const $chip = $(`
            <div class="rst-chip${isSelected ? " on" : ""}">
                <div class="rst-av">${initials}</div>
                <div>
                    <div style="font-weight:500">${char.name}</div>
                    <div style="font-size:11px;color:var(--rst-text-muted)">${isPresent ? "present" : "not present"}</div>
                </div>
                ${isPresent ? '<div class="rst-dot" style="margin-left:auto"></div>' : ""}
            </div>
        `);

        $chip.on("click", () => {
            selectedCharId = char.id;
            renderLibraryTab($pane);
        });

        $pane.append($chip);
    }
}

// ─── Character Display Card ───────────────────────────────

/**
 * Render the full character display card.
 * @param {jQuery} $pane
 * @param {object} profile
 */
function renderCharacterCard($pane, profile) {
    const initials = getInitials(profile.name);
    const sourceLabel = profile.source === "character_card" ? "From character card" :
                        profile.source === "auto_generated" ? "Auto-generated" : "Manual entry";

    const $card = $(`<div class="rst-card"></div>`);

    // Header
    const $header = $(`
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
            <div class="rst-av" style="width:40px;height:40px;font-size:14px">${initials}</div>
            <div>
                <div style="font-size:15px;font-weight:500">${profile.name}</div>
                <div style="font-size:11px;color:var(--rst-text-muted)">${sourceLabel}</div>
            </div>
            <div style="margin-left:auto;display:flex;gap:6px">
                <button class="rst-icon-btn rst-wand-btn" title="Generate profile">✦</button>
                <button class="rst-icon-btn rst-log-btn" title="Update log">◷</button>
                <button class="rst-icon-btn rst-delete-btn" style="color:var(--rst-danger)" title="Delete character">✕</button>
            </div>
        </div>
    `);

    $header.find(".rst-wand-btn").on("click", () => showWandModal(profile));
    $header.find(".rst-log-btn").on("click", () => toggleLogPanel(profile));
    $header.find(".rst-delete-btn").on("click", () => confirmDeleteCharacter(profile));

    $card.append($header);

    // Profile textareas
    $card.append('<div class="rst-lbl">Profile</div>');
    const $desc = $(`<textarea rows="2" style="margin-bottom:8px">${profile.description || ""}</textarea>`);
    const $notes = $(`<textarea rows="2">${profile.notes ? "Notes: " + profile.notes : ""}</textarea>`);

    $desc.on("change", function () {
        updateCharacterProfile(profile.id, { description: $(this).val() });
    });
    $notes.on("change", function () {
        updateCharacterProfile(profile.id, { notes: $(this).val() });
    });

    $card.append($desc);
    $card.append($notes);
    $card.append('<hr class="rst-div">');

    // Stats header
    $card.append(`
        <div style="display:flex;align-items:baseline;gap:6px;margin-bottom:4px">
            <div class="rst-lbl" style="margin-bottom:0">Relationship stats</div>
            <span style="font-size:11px;color:var(--rst-text-muted)">click a category for details</span>
        </div>
    `);

    // Stat grid
    const $statGrid = $('<div class="rst-stat-grid"></div>');
    for (const cat of STAT_CATEGORIES) {
        $statGrid.append(renderStatCategoryForLibrary(cat, profile));
    }
    $card.append($statGrid);

    // Dynamic title & narrative
    if (profile.dynamicTitle) {
        $card.append(`<div class="rst-dyn">${profile.dynamicTitle}</div>`);
    }
    if (profile.narrativeSummary) {
        $card.append(`<div class="rst-narr">${profile.narrativeSummary}</div>`);
    }

    $pane.append($card);
}

/**
 * Render a stat category block for the library view.
 * @param {string} cat
 * @param {object} profile
 * @returns {jQuery}
 */
function renderStatCategoryForLibrary(cat, profile) {
    const catTitle = cat.charAt(0).toUpperCase() + cat.slice(1);
    const $cat = $(`<div class="rst-stat-cat"></div>`);
    $cat.append(`<div class="rst-sct">${catTitle} <span style="font-weight:400;font-size:10px">▾</span></div>`);

    for (const stat of STAT_NAMES) {
        const val = profile.stats[cat][stat];
        const cls = val > 0 ? "p" : val < 0 ? "n" : "z";
        const commentary = profile.updateLog?.[0]?.commentary?.[cat]?.[stat] || "";

        $cat.append(`
            <div class="rst-sr">
                <span class="rst-sn">${stat.charAt(0).toUpperCase() + stat.slice(1)}</span>
                <span class="rst-sv ${cls}">${val}%</span>
            </div>
            <div class="rst-sc">${commentary}</div>
        `);
    }

    $cat.on("click", function () {
        $(this).toggleClass("open");
    });

    return $cat;
}

// ─── Update Log Panel ─────────────────────────────────────

/**
 * Toggle the update log panel for a character.
 * @param {object} profile
 */
function toggleLogPanel(profile) {
    const $wrap = $("#rst-log-wrap");
    if ($wrap.is(":visible")) {
        $wrap.hide();
        return;
    }

    $wrap.empty();
    $wrap.append('<div class="rst-lbl">Update log (last 5 entries)</div>');

    if (!profile.updateLog || profile.updateLog.length === 0) {
        $wrap.append('<div style="font-size:12px;color:var(--rst-text-muted)">No update log entries yet.</div>');
    } else {
        for (const entry of profile.updateLog) {
            const $entry = renderLogEntry(entry, profile);
            $wrap.append($entry);
        }
    }

    $wrap.show();
}

/**
 * Render a single update log entry.
 * @param {object} entry
 * @param {object} profile
 * @returns {jQuery}
 */
function renderLogEntry(entry, profile) {
    const sceneNum = entry.sceneId?.replace("scene_", "") || "?";
    const timeAgo = formatTimeAgo(entry.timestamp);
    const msgRange = entry.messageRange ? `msgs ${entry.messageRange.start}–${entry.messageRange.end}` : "";

    const $entry = $(`
        <div class="rst-log-entry">
            <div class="rst-log-meta">Scene ${sceneNum} · ${msgRange} · ${timeAgo}</div>
        </div>
    `);

    // Show notable stat changes
    for (const cat of STAT_CATEGORIES) {
        for (const stat of STAT_NAMES) {
            const before = entry.statsBefore?.[cat]?.[stat];
            const after = entry.statsAfter?.[cat]?.[stat];
            if (before !== undefined && after !== undefined && before !== after) {
                const cls = after > before ? "p" : "n";
                const catTitle = cat.charAt(0).toUpperCase() + cat.slice(1);
                const statTitle = stat.charAt(0).toUpperCase() + stat.slice(1);
                $entry.append(`
                    <div class="rst-sr">
                        <span>${catTitle} / ${statTitle}</span>
                        <span class="rst-sv ${cls}">${before}% → ${after}%</span>
                    </div>
                `);
                const commentary = entry.commentary?.[cat]?.[stat];
                if (commentary) {
                    $entry.append(`<div style="font-size:11px;color:var(--rst-text-muted);padding:3px 0;line-height:1.4">${commentary}</div>`);
                }
            }
        }
    }

    // Rollback / Delete buttons
    const $btnRow = $(`
        <div class="rst-btn-row" style="margin-top:8px">
            <button class="rst-btn rst-rollback-btn">Rollback</button>
            <button class="rst-btn-danger rst-delete-log-btn">Delete</button>
        </div>
    `);

    $btnRow.find(".rst-rollback-btn").on("click", () => {
        showRollbackConfirmation(profile, entry);
    });

    $btnRow.find(".rst-delete-log-btn").on("click", () => {
        removeUpdateLogEntry(profile.id, entry.sceneId);
        toastr?.success?.("Log entry deleted.");
        const $pane = $("#rst-p-lib");
        renderLibraryTab($pane);
    });

    $entry.append($btnRow);
    return $entry;
}

// ─── Rollback Confirmation ────────────────────────────────

/**
 * Show the rollback confirmation dialog.
 * @param {object} profile
 * @param {object} entry
 */
function showRollbackConfirmation(profile, entry) {
    const $overlay = $(`
        <div class="rst-overlay" style="position:fixed;inset:0;z-index:10000">
            <div class="rst-rollback-dialog">
                <div class="rst-rollback-warning">⚠ WARNING: Rollbacks cannot be reversed.</div>
                <div class="rst-rollback-detail">
                    Are you sure you want to proceed?<br><br>
                    Rolling back will restore:
                    <ul>
                        <li>All 12 stats to their previous values</li>
                        <li>Dynamic title to: "${entry.dynamicTitleBefore || "None"}"</li>
                        <li>Narrative summary to previous version</li>
                    </ul>
                </div>
                <div class="rst-btn-row">
                    <button class="rst-btn rst-cancel-rollback">Cancel</button>
                    <button class="rst-btn-danger rst-confirm-rollback">Confirm Rollback</button>
                </div>
            </div>
        </div>
    `);

    $overlay.find(".rst-cancel-rollback").on("click", () => {
        $overlay.remove();
    });

    $overlay.find(".rst-confirm-rollback").on("click", async () => {
        try {
            // Restore stats
            updateCharacterStats(profile.id, entry.statsBefore);

            // Restore dynamic title and narrative
            updateCharacterProfile(profile.id, {
                dynamicTitle: entry.dynamicTitleBefore,
                narrativeSummary: entry.narrativeSummary || profile.narrativeSummary,
            });

            // Remove this log entry
            removeUpdateLogEntry(profile.id, entry.sceneId);

            $overlay.remove();
            toastr?.success?.(`Rollback complete. ${profile.name} stats restored to pre-${entry.sceneId} state.`);

            const $pane = $("#rst-p-lib");
            renderLibraryTab($pane);

            // Update injection
            const { updateInjection } = await import("../inject/promptInjector.js");
            updateInjection();
        } catch (err) {
            console.error("[RST] Rollback failed:", err);
            toastr?.error?.("Rollback failed. Please try again.");
            $overlay.remove();
        }
    });

    $("body").append($overlay);
}

// ─── Wand Modal (Profile Generation) ─────────────────────

/**
 * Show the magic wand profile generation modal.
 * @param {object} profile
 */
function showWandModal(profile) {
    const $wrap = $("#rst-wand-wrap");
    $wrap.empty();

    const $modal = $(`
        <div class="rst-overlay">
            <div class="rst-modal">
                <div style="font-size:14px;font-weight:500;margin-bottom:5px">Generate profile</div>
                <div style="font-size:12px;color:var(--rst-text-muted);margin-bottom:10px">Add an optional prompt or leave blank to generate from scene context alone.</div>
                <textarea rows="3" style="margin-bottom:10px" placeholder="e.g. Focus on his psychology and emotional contradictions..."></textarea>
                <div class="rst-btn-row" style="margin-bottom:8px">
                    <button class="rst-btn" style="flex:1" id="rst-wand-prompt">Generate from prompt</button>
                    <button class="rst-btn" style="flex:1" id="rst-wand-scene">Generate from scene</button>
                </div>
                <button class="rst-btn" style="width:100%;color:var(--rst-text-muted)" id="rst-wand-cancel">Cancel</button>
            </div>
        </div>
    `);

    $modal.find("#rst-wand-prompt").on("click", async () => {
        const prompt = $modal.find("textarea").val().trim();
        await runProfileGen(profile.name, prompt, false);
        $wrap.hide();
    });

    $modal.find("#rst-wand-scene").on("click", async () => {
        await runProfileGen(profile.name, "", true);
        $wrap.hide();
    });

    $modal.find("#rst-wand-cancel").on("click", () => {
        $wrap.hide();
    });

    $wrap.append($modal);
    $wrap.show();
}

/**
 * Run profile generation and update the character.
 * @param {string} name
 * @param {string} prompt
 * @param {boolean} fromScene
 */
async function runProfileGen(name, prompt, fromScene) {
    try {
        const result = await generateProfile(name, prompt, fromScene);

        // Find the character and update it
        const chars = getAllCharacters();
        const char = chars.find((c) => c.name === name);
        if (char) {
            updateCharacterProfile(char.id, {
                description: result.description,
                notes: result.notes,
                dynamicTitle: result.dynamicTitle,
                narrativeSummary: result.narrativeSummary,
                source: "auto_generated",
            });
            updateCharacterStats(char.id, result.stats);

            toastr?.success?.(`${name} profile generated successfully.`);
            const $pane = $("#rst-p-lib");
            renderLibraryTab($pane);
        }
    } catch (err) {
        console.error("[RST] Profile generation failed:", err);
    }
}

// ─── New Character Dialog ─────────────────────────────────

/**
 * Show the new character creation dialog.
 * @param {jQuery} $pane
 */
function showNewCharacterDialog($pane) {
    const name = prompt("Enter character name:");
    if (!name || !name.trim()) return;

    createCharacter(name.trim());
    selectedCharId = null; // Will be set after re-render
    toastr?.success?.(`New character profile created for ${name.trim()}.`);
    renderLibraryTab($pane);
}

/**
 * Show the "new character detected" modal.
 * @param {string} name
 */
export function showNewCharacterDetected(name) {
    const $wrap = $("#rst-newchar-wrap");
    if ($wrap.length === 0) return;

    $wrap.empty();

    const $modal = $(`
        <div class="rst-overlay">
            <div class="rst-modal">
                <div style="font-size:14px;font-weight:500;margin-bottom:5px">New character detected</div>
                <div style="font-size:12px;color:var(--rst-text-muted);margin-bottom:12px">${name} was found in the current context. Create a blank profile entry?</div>
                <div class="rst-btn-row">
                    <button class="rst-btn-approve" style="flex:1" id="rst-newchar-create">Create entry</button>
                    <button class="rst-btn" style="flex:1" id="rst-newchar-ignore">Ignore</button>
                </div>
            </div>
        </div>
    `);

    $modal.find("#rst-newchar-create").on("click", () => {
        createCharacter(name);
        toastr?.success?.(`New character profile created for ${name}.`);
        $wrap.hide();
        const $pane = $("#rst-p-lib");
        renderLibraryTab($pane);
    });

    $modal.find("#rst-newchar-ignore").on("click", () => {
        $wrap.hide();
    });

    $wrap.append($modal);
    $wrap.show();
}

// ─── Delete Character ─────────────────────────────────────

/**
 * Confirm and delete a character.
 * @param {object} profile
 */
function confirmDeleteCharacter(profile) {
    if (!confirm(`Are you sure you want to delete ${profile.name}? This cannot be undone.`)) return;

    deleteCharacter(profile.id);
    if (selectedCharId === profile.id) selectedCharId = null;
    toastr?.info?.(`${profile.name} deleted.`);
    const $pane = $("#rst-p-lib");
    renderLibraryTab($pane);
}

// ─── Import/Export ────────────────────────────────────────

/**
 * Download character data as a JSON file.
 */
function downloadExport() {
    const data = exportCharacters();
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "rst-characters.json";
    a.click();
    URL.revokeObjectURL(url);
    toastr?.success?.("Character data exported.");
}

/**
 * Trigger file import for character data.
 */
function triggerImport() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const text = await file.text();
        const count = importCharacters(text);
        if (count >= 0) {
            toastr?.success?.(`${count} characters imported.`);
            const $pane = $("#rst-p-lib");
            renderLibraryTab($pane);
        } else {
            toastr?.error?.("Failed to import character data.");
        }
    };
    input.click();
}
