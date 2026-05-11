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
    addUpdateLogEntry,
    cloneStats,
    createBlankStats,
    removeUpdateLogEntry,
    removeUpdateLogEntryByTimestamp,
    exportCharacters,
    importCharacters,
    STAT_CATEGORIES,
    STAT_NAMES,
} from "../data/characters.js";
import { generateProfile } from "../llm/profileGen.js";
import { formatTimeAgo } from "../data/scenes.js";
import { Popup, POPUP_RESULT, POPUP_TYPE } from "../../../../../scripts/popup.js";
import { showPanelLoading, hidePanelLoading } from "./panel.js";

// ─── State ────────────────────────────────────────────────

let selectedCharId = null;

/** @type {Set<string>} Set of character IDs selected for bulk operations */
const selectedCharIds = new Set();

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

    // Bulk action toolbar (shown only when characters exist)
    const chars = getAllCharacters();
    if (chars.length > 0) {
        const $bulkToolbar = $(`
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:6px 4px;border:0.5px solid var(--rst-border);border-radius:6px;background:var(--rst-bg-secondary, rgba(0,0,0,0.05))">
                <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer">
                    <input type="checkbox" id="rst-select-all-chars" style="margin:0">
                    Select all
                </label>
                <button id="rst-delete-selected-chars" class="rst-btn-danger" style="font-size:11px;padding:3px 10px;opacity:0.5;pointer-events:none" disabled>Delete selected (0)</button>
            </div>
        `);

        // Select all toggle
        $bulkToolbar.find("#rst-select-all-chars").on("change", function () {
            const checked = $(this).prop("checked");
            $pane.find(".rst-char-select").prop("checked", checked).trigger("change");
        });

        // Delete selected handler
        $bulkToolbar.find("#rst-delete-selected-chars").on("click", async function () {
            const count = selectedCharIds.size;
            if (count === 0) return;
            const confirmed = await Popup.show.confirm(
                "Delete Characters",
                `Delete ${count} selected character${count > 1 ? "s" : ""}? This cannot be undone.`
            );
            if (!confirmed) return;
            for (const charId of selectedCharIds) {
                deleteCharacter(charId);
            }
            selectedCharIds.clear();
            if (selectedCharId && !chars.some(c => c.id === selectedCharId)) {
                selectedCharId = null;
            }
            toastr?.info?.(`${count} character${count > 1 ? "s" : ""} deleted.`);
            renderLibraryTab($pane);
        });

        $pane.append($bulkToolbar);
    }

    // Character chips — each with an inline collapsible card underneath
    renderCharacterChips($pane);

    // Hidden wraps for inline panels
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

        const $wrap = $(`<div class="rst-chip-wrap"></div>`);

        const $chip = $(`
            <div class="rst-chip${isSelected ? " on" : ""}">
                <input type="checkbox" class="rst-char-select" data-char-id="${char.id}" style="margin:0;cursor:pointer;flex-shrink:0" title="Select this character">
                <div class="rst-av">${initials}</div>
                <div>
                    <div style="font-weight:500">${char.name}</div>
                    <div style="font-size:11px;color:var(--rst-text-muted)">${isPresent ? "present" : "not present"}</div>
                </div>
                ${isPresent ? '<div class="rst-dot" style="margin-left:auto"></div>' : ""}
            </div>
        `);

        const $cardWrap = $(`<div class="rst-card-wrap" style="display:${isSelected ? "block" : "none"}"></div>`);

        // Wire up bulk selection checkbox
        const $checkbox = $chip.find(".rst-char-select");
        $checkbox.on("change", function () {
            const checked = $(this).prop("checked");
            const charId = $(this).data("char-id");
            if (checked) {
                selectedCharIds.add(charId);
            } else {
                selectedCharIds.delete(charId);
            }
            // Update bulk action toolbar state
            const $toolbar = $pane.find("#rst-delete-selected-chars");
            const count = selectedCharIds.size;
            $toolbar.text(`Delete selected (${count})`);
            if (count > 0) {
                $toolbar.prop("disabled", false).css({ opacity: 1, pointerEvents: "auto" });
            } else {
                $toolbar.prop("disabled", true).css({ opacity: 0.5, pointerEvents: "none" });
            }
            // Uncheck "Select all" if not all selected
            const totalCheckboxes = $pane.find(".rst-char-select").length;
            const checkedCheckboxes = $pane.find(".rst-char-select:checked").length;
            const $selectAll = $pane.find("#rst-select-all-chars");
            $selectAll.prop("checked", totalCheckboxes > 0 && checkedCheckboxes === totalCheckboxes);
        });

        $chip.on("click", (e) => {
            // Don't toggle card when clicking the checkbox
            if ($(e.target).is("input[type=checkbox]")) return;

            // Clicking the already-selected chip collapses the card
            if (selectedCharId === char.id) {
                selectedCharId = null;
                $chip.removeClass("on");
                $cardWrap.slideUp(200);
                return;
            }

            // Close any other open card
            $pane.find(".rst-chip.on").removeClass("on");
            $pane.find(".rst-card-wrap:visible").slideUp(200);

            // Select this chip
            selectedCharId = char.id;
            $chip.addClass("on");

            // Render card content if not already rendered
            if ($cardWrap.is(":empty")) {
                const profile = getCharacterProfile(char.id);
                if (profile) {
                    renderCharacterCard($cardWrap, profile);
                }
            }

            $cardWrap.slideDown(200);
        });

        $wrap.append($chip);
        $wrap.append($cardWrap);
        $pane.append($wrap);

        // If this character was previously selected, ensure the card is rendered
        if (isSelected) {
            const profile = getCharacterProfile(char.id);
            if (profile) {
                renderCharacterCard($cardWrap, profile);
            }
        }
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

    const $card = $(`<div class="rst-card"></div>`);

    // Header
    const $header = $(`
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
            <div class="rst-av" style="width:40px;height:40px;font-size:14px">${initials}</div>
            <div style="flex:1">
                <input type="text" class="rst-char-name" value="${profile.name}"
                    style="font-size:15px;font-weight:500;width:100%;padding:2px 4px">
            </div>
            <div style="margin-left:auto;display:flex;gap:6px">
                <button class="rst-icon-btn rst-wand-btn" title="Generate profile">✦</button>
                <button class="rst-icon-btn rst-edit-btn" title="Edit stats">✎</button>
                <button class="rst-icon-btn rst-log-btn" title="Update log">◷</button>
                <button class="rst-icon-btn rst-delete-btn" style="color:var(--rst-danger)" title="Delete character">✕</button>
            </div>
        </div>
    `);

    $header.find(".rst-wand-btn").on("click", () => showWandModal(profile));
    $header.find(".rst-edit-btn").on("click", () => showEditStatsModal(profile));
    $header.find(".rst-log-btn").on("click", () => toggleLogPanel(profile));
    $header.find(".rst-delete-btn").on("click", () => confirmDeleteCharacter(profile));

    // Editable character name
    const $nameInput = $header.find(".rst-char-name");
    $nameInput.on("change", function () {
        const newName = $(this).val().trim();
        if (newName && newName !== profile.name) {
            updateCharacterProfile(profile.id, { name: newName });
            profile.name = newName;
            const $pane = $("#rst-p-lib");
            renderLibraryTab($pane);
        } else if (!newName) {
            $(this).val(profile.name);
        }
    });

    $card.append($header);

    // Name aliases (comma-separated, for sidecar matching)
    const aliasesStr = (profile.nameAliases && Array.isArray(profile.nameAliases))
        ? profile.nameAliases.join(", ")
        : "";
    const $aliasesRow = $(`
        <div style="margin-bottom:8px">
            <div class="rst-lbl" style="margin-bottom:2px">Name aliases</div>
            <div style="font-size:11px;color:var(--rst-text-muted);margin-bottom:4px;line-height:1.4">
                Alternative names this character is known by (comma-separated). Used by sidecar detection
                to match LLM output (e.g. "Gojo") against your library entry (e.g. "Satoru Gojo").
            </div>
            <input type="text" class="rst-char-aliases" value="${aliasesStr}"
                style="width:100%;padding:4px 6px;font-size:12px"
                placeholder="e.g. Gojo, Satoru">
        </div>
    `);
    const $aliasesInput = $aliasesRow.find(".rst-char-aliases");
    $aliasesInput.on("change", function () {
        const raw = $(this).val();
        const aliases = raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        updateCharacterProfile(profile.id, { nameAliases: aliases });
        profile.nameAliases = aliases;
    });
    $card.append($aliasesRow);

    // Profile textareas
    $card.append(`
        <div style="display:flex;align-items:baseline;gap:6px">
            <div class="rst-lbl">Personality</div>
            <i class="editor_maximize fa-solid fa-maximize right_menu_button" data-for="rst-lib-personality-${profile.id}" title="Expand the editor" style="margin-left:auto;display:inline-block;font-size:14px;vertical-align:middle;opacity:0.85;filter:grayscale(1);cursor:pointer;transition:all var(--animation-duration-2x,0.3s) ease-in-out"></i>
        </div>
    `);
    const $desc = $(`<textarea id="rst-lib-personality-${profile.id}" rows="2" style="margin-bottom:8px">${profile.description || ""}</textarea>`);
    $card.append($desc);
    $card.append(`
        <div style="display:flex;align-items:baseline;gap:6px;margin-top:8px">
            <div class="rst-lbl">Character Notes</div>
            <i class="editor_maximize fa-solid fa-maximize right_menu_button" data-for="rst-lib-notes-${profile.id}" title="Expand the editor" style="margin-left:auto;display:inline-block;font-size:14px;vertical-align:middle;opacity:0.85;filter:grayscale(1);cursor:pointer;transition:all var(--animation-duration-2x,0.3s) ease-in-out"></i>
        </div>
    `);
    const $notes = $(`<textarea id="rst-lib-notes-${profile.id}" rows="2">${profile.notes || ""}</textarea>`);

    $desc.on("change", function () {
        updateCharacterProfile(profile.id, { description: $(this).val() });
    });
    $notes.on("change", function () {
        updateCharacterProfile(profile.id, { notes: $(this).val() });
    });

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
/**
 * Find the most recent non-empty commentary for a stat across all log entries.
 * Falls back through log entries so deleting the newest entry doesn't blank commentaries.
 * @param {object} profile
 * @param {string} cat
 * @param {string} stat
 * @returns {string}
 */
function findLatestCommentary(profile, cat, stat) {
    if (!profile.updateLog) return "";
    for (const entry of profile.updateLog) {
        const c = entry.commentary?.[cat]?.[stat];
        if (c && typeof c === "string" && c.trim()) return c.trim();
    }
    return "";
}

function renderStatCategoryForLibrary(cat, profile) {
    const catTitle = cat.charAt(0).toUpperCase() + cat.slice(1);
    const $cat = $(`<div class="rst-stat-cat"></div>`);
    $cat.append(`<div class="rst-sct">${catTitle} <span style="font-weight:400;font-size:10px">▾</span></div>`);

    for (const stat of STAT_NAMES) {
        const val = profile.stats[cat][stat];
        const cls = val > 0 ? "p" : val < 0 ? "n" : "z";
        const commentary = findLatestCommentary(profile, cat, stat);

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
    const msgRange = (entry.messageRange && typeof entry.messageRange.start === "number") ? `msgs ${entry.messageRange.start}–${entry.messageRange.end}` : "no msg range";

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
            if (after === undefined) continue;

            const catTitle = cat.charAt(0).toUpperCase() + cat.slice(1);
            const statTitle = stat.charAt(0).toUpperCase() + stat.slice(1);

            if (before !== undefined && before !== after) {
                // Change: show before → after
                const cls = after > before ? "p" : "n";
                $entry.append(`
                    <div class="rst-sr">
                        <span>${catTitle} / ${statTitle}</span>
                        <span class="rst-sv ${cls}">${before}% → ${after}%</span>
                    </div>
                `);
            } else if (before === undefined && after !== 0) {
                // Initial stat: show as "set to X%"
                const cls = after > 0 ? "p" : "n";
                $entry.append(`
                    <div class="rst-sr">
                        <span>${catTitle} / ${statTitle}</span>
                        <span class="rst-sv ${cls}">set to ${after}%</span>
                    </div>
                `);
            } else {
                // Unchanged stat or 0→0: skip
                continue;
            }

            const commentary = entry.commentary?.[cat]?.[stat];
            if (commentary) {
                $entry.append(`<div style="font-size:11px;color:var(--rst-text-muted);padding:3px 0;line-height:1.4">${commentary}</div>`);
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
        // Use timestamp (unique per entry) instead of sceneId (shared across entries in same scene)
        removeUpdateLogEntryByTimestamp(profile.id, entry.timestamp);
        toastr?.success?.("Log entry deleted.");
        const $pane = $("#rst-p-lib");
        renderLibraryTab($pane);
    });

    $entry.append($btnRow);
    return $entry;
}

// ─── Rollback Confirmation ────────────────────────────────

/**
 * Show the rollback confirmation dialog via ST Popup.
 * @param {object} profile
 * @param {object} entry
 */
async function showRollbackConfirmation(profile, entry) {
    const hasStatsBefore = !!entry.statsBefore;

    const detailLines = [
        "Are you sure you want to proceed? Rollbacks cannot be reversed.\n",
    ];

    if (hasStatsBefore) {
        detailLines.push(
            "Rolling back will restore:",
            "• All 12 stats to their previous values",
            `• Dynamic title to: "${entry.dynamicTitleBefore || "None"}"`,
            "• Narrative summary to previous version",
        );
    } else {
        detailLines.push(
            "⚠ No previous stats recorded for this entry.",
            "Rolling back will NOT change current stats — only the log entry will be removed.",
            `• Dynamic title will revert to: "${entry.dynamicTitleBefore || "None"}"`,
            "• Narrative summary will revert to previous version",
        );
    }

    const result = await Popup.show.confirm(
        hasStatsBefore ? "⚠ Rollback warning" : "⚠ Rollback — no previous stats recorded",
        detailLines.join("\n"),
    );

    if (result !== POPUP_RESULT.AFFIRMATIVE) return;

    try {
        // Only restore stats if we have previous values to restore
        if (hasStatsBefore) {
            updateCharacterStats(profile.id, entry.statsBefore);
        }

        // Restore dynamic title — only if we have a meaningful value to restore
        // (empty string from batch init means "no title change", don't clear existing)
        const profileUpdates = {};
        if (entry.dynamicTitleBefore) {
            profileUpdates.dynamicTitle = entry.dynamicTitleBefore;
        }
        // Restore narrative summary to entry's version (even if empty string)
        profileUpdates.narrativeSummary = entry.narrativeSummary ?? "";
        updateCharacterProfile(profile.id, profileUpdates);

        // Determine a display-friendly reference for the toast
        const sceneRef = entry.sceneId && entry.sceneId !== "" ? entry.sceneId : "manual edit";
        const sourceRef = entry.source || sceneRef;

        // Remove this log entry by unique timestamp
        removeUpdateLogEntryByTimestamp(profile.id, entry.timestamp);

        toastr?.success?.(
            hasStatsBefore
                ? `Rollback complete. ${profile.name} stats restored to pre-${sourceRef} state.`
                : `Log entry removed. ${profile.name} stats left unchanged (no previous stats to restore).`
        );

        const $pane = $("#rst-p-lib");
        renderLibraryTab($pane);

        // Update injection
        const { updateInjection } = await import("../inject/promptInjector.js");
        updateInjection();
    } catch (err) {
        console.error("[RST] Rollback failed:", err);
        toastr?.error?.("Rollback failed. Please try again.");
    }
}

// ─── Edit Stats Modal ───────────────────────────────────────

/**
 * Show the edit stats dialog via ST Popup.
 * All 12 stat values and their 12 commentary texts are editable.
 * On save: old stats → update log, new stats → current.
 * @param {object} profile
 */
async function showEditStatsModal(profile) {
    const catTitle = (cat) => cat.charAt(0).toUpperCase() + cat.slice(1);
    const statLabel = (s) => s.charAt(0).toUpperCase() + s.slice(1);

    // Build per-stat input groups
    let fieldsHtml = "";
    for (const cat of STAT_CATEGORIES) {
        fieldsHtml += `<div style="font-weight:600;margin:10px 0 4px;font-size:13px;color:var(--SmartThemeBodyColor,#ccc)">── ${catTitle(cat)} ──</div>`;
        for (const stat of STAT_NAMES) {
            const val = profile.stats[cat][stat];
            const commentary = findLatestCommentary(profile, cat, stat);
            fieldsHtml += `
                <div style="margin-bottom:8px">
                    <div style="font-size:12px;font-weight:500;margin-bottom:2px">${statLabel(stat)}</div>
                    <div style="display:flex;gap:6px;align-items:center">
                        <input type="number" min="-100" max="100" value="${val}"
                            data-cat="${cat}" data-stat="${stat}"
                            class="rst-edit-val" style="width:80px;flex-shrink:0;background:transparent;color:inherit">
                        <span style="font-size:11px;color:var(--SmartThemeBodyColor,#666)">%</span>
                    </div>
                    <textarea rows="2" data-cat="${cat}" data-stat="${stat}"
                        class="rst-edit-com" style="width:100%;margin-top:2px"
                        placeholder="Reason / commentary...">${commentary}</textarea>
                </div>
            `;
        }
    }

    // Dynamic title & narrative summary from profile
    const currentTitle = profile.dynamicTitle || "";
    const currentNarrative = profile.narrativeSummary || "";

    const html = `
        <h3>Edit Stats — ${profile.name}</h3>
        <p style="margin-bottom:6px;font-size:12px;color:var(--SmartThemeBodyColor,#999)">
            Edit stat values (−100 to +100) and their associated commentary.
            Old values will be saved in the update log.
        </p>
        <div style="max-height:60vh;overflow-y:auto;padding-right:4px">
            ${fieldsHtml}

            <div style="border-top:1px solid var(--SmartThemeBorderColor,#333);margin:12px 0 10px;padding-top:10px">
                <div style="font-weight:600;margin-bottom:4px;font-size:13px;color:var(--SmartThemeBodyColor,#ccc)">── Dynamic Title ──</div>
                <input type="text" id="rst-lib-edit-title" value="${currentTitle}"
                    style="width:100%;padding:5px 8px;font-size:12px;background:transparent;color:inherit">

                <div style="font-weight:600;margin:10px 0 4px;font-size:13px;color:var(--SmartThemeBodyColor,#ccc)">── Narrative Summary ──</div>
                <textarea id="rst-lib-edit-narrative" rows="3"
                    style="width:100%;padding:5px 8px;font-size:12px;resize:vertical">${currentNarrative}</textarea>
            </div>
        </div>
    `;

    const popup = new Popup(html, POPUP_TYPE.TEXT, "", {
        customButtons: [
            {
                text: "Save Changes",
                result: 1,
                action: async () => {
                    // Collect stat values
                    const newStats = {};
                    const newCommentary = {};
                    for (const cat of STAT_CATEGORIES) {
                        newStats[cat] = {};
                        newCommentary[cat] = {};
                        for (const stat of STAT_NAMES) {
                            const valInput = document.querySelector(`.rst-edit-val[data-cat="${cat}"][data-stat="${stat}"]`);
                            const comInput = document.querySelector(`.rst-edit-com[data-cat="${cat}"][data-stat="${stat}"]`);
                            newStats[cat][stat] = parseInt(valInput?.value, 10) || 0;
                            newCommentary[cat][stat] = comInput?.value || "";
                        }
                    }

                    // Collect dynamic title & narrative summary
                    const titleInput = document.getElementById("rst-lib-edit-title");
                    const narrativeInput = document.getElementById("rst-lib-edit-narrative");
                    const newTitle = titleInput?.value || "";
                    const newNarrative = narrativeInput?.value || "";

                    // Clone old stats before overwriting
                    const oldStats = cloneStats(profile.stats);

                    // Update current stats
                    updateCharacterStats(profile.id, newStats);

                    // Update dynamic title & narrative summary
                    updateCharacterProfile(profile.id, {
                        dynamicTitle: newTitle,
                        narrativeSummary: newNarrative,
                    });

                    // Add update log entry with old stats, new stats, and edited commentary
                    addUpdateLogEntry(profile.id, {
                        statsBefore: oldStats,
                        statsAfter: newStats,
                        commentary: newCommentary,
                        source: "manual_edit",
                        timestamp: Date.now(),
                    });

                    toastr?.success?.(`${profile.name} stats updated.`);

                    // Refresh the library UI
                    const $pane = $("#rst-p-lib");
                    renderLibraryTab($pane);
                    popup.complete(1);
                },
            },
        ],
        okButton: "Cancel",
    });

    await popup.show();
}

// ─── Wand Modal (Profile Generation) ─────────────────────

/**
 * Show the magic wand profile generation dialog via ST Popup.
 * @param {object} profile
 */
async function showWandModal(profile) {
    const html = `
        <h3>Generate profile</h3>
        <p style="margin-bottom:10px;font-size:12px;color:var(--SmartThemeBodyColor,#999)">
            Add an optional prompt or leave blank to generate from scene context alone.
        </p>
        <textarea id="rst-wand-input" rows="3" style="width:100%" placeholder="e.g. Focus on his psychology and emotional contradictions..."></textarea>
    `;

    const popup = new Popup(html, POPUP_TYPE.TEXT, "", {
        customButtons: [
            {
                text: "Generate from prompt",
                result: 2,
                action: async () => {
                    const textarea = document.getElementById("rst-wand-input");
                    const prompt = textarea?.value?.trim() || "";
                    await runProfileGen(profile.name, prompt, false);
                    popup.complete(2);
                },
            },
            {
                text: "Generate from scene",
                result: 3,
                action: async () => {
                    await runProfileGen(profile.name, "", true);
                    popup.complete(3);
                },
            },
        ],
        okButton: "Cancel",
    });

    await popup.show();
}

/**
 * Run profile generation and update the character.
 * @param {string} name
 * @param {string} prompt
 * @param {boolean} fromScene
 */
async function runProfileGen(name, prompt, fromScene) {
    showPanelLoading(`Generating profile for ${name}...`);
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

            toastr?.success?.(`${name} profile generated successfully.`);
            const $pane = $("#rst-p-lib");
            renderLibraryTab($pane);
        }
    } catch (err) {
        console.error("[RST] Profile generation failed:", err);
    } finally {
        hidePanelLoading();
    }
}

// ─── New Character Dialog ─────────────────────────────────

/**
 * Show the new character creation dialog via ST Popup input.
 * @param {jQuery} $pane
 */
async function showNewCharacterDialog($pane) {
    const name = await Popup.show.input("New character", "Enter character name:");
    if (!name || !name.trim()) return;

    createCharacter(name.trim());
    selectedCharId = null;
    toastr?.success?.(`New character profile created for ${name.trim()}.`);
    renderLibraryTab($pane);
}

/**
 * Show the "new character detected" dialog via ST Popup confirm.
 * @param {string} name
 */
export async function showNewCharacterDetected(name) {
    const result = await Popup.show.confirm(
        "New character detected",
        `${name} was found in the current context. Create a blank profile entry?`,
        { okButton: "Create entry", cancelButton: "Ignore" },
    );

    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return false; // User clicked "Ignore"
    }

    createCharacter(name);
    toastr?.success?.(`New character profile created for ${name}.`);
    const $pane = $("#rst-p-lib");
    renderLibraryTab($pane);
    return true; // Character was created
}

// ─── Delete Character ─────────────────────────────────────

/**
 * Confirm and delete a character via ST Popup confirm.
 * @param {object} profile
 */
async function confirmDeleteCharacter(profile) {
    const result = await Popup.show.confirm(
        "Delete character",
        `Are you sure you want to delete ${profile.name}? This cannot be undone.`,
    );

    if (result !== POPUP_RESULT.AFFIRMATIVE) return;

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
        const { count, errors } = importCharacters(text);
        if (count >= 0) {
            toastr?.success?.(`${count} characters imported.`);
            if (errors.length > 0) {
                toastr?.warning?.(`${errors.length} entries skipped:\n${errors.join("\n")}`, null, { timeOut: 10000 });
            }
            const $pane = $("#rst-p-lib");
            renderLibraryTab($pane);
        } else {
            toastr?.error?.(`Failed to import character data.\n${errors.join("\n")}`);
        }
    };
    input.click();
}
