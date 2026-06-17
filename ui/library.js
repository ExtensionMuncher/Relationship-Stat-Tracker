/**
 * library.js — Character Library tab: list, display, wand, logs
 * Renders the character library with full stat display, update logs, and profile generation
 * v2: search, filter chips, sort, folder organization, profile picture upload + crop
 */

import { getPresentCharacters } from "../data/storage.js";
import { getContext } from "../../../../extensions.js";
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
    getMostRecentTimestamp,
    getFolders,
    saveFolders,
    createFolder,
    renameFolder,
    deleteFolderAndEject,
    moveCharToFolder,
    getCharactersInFolder,
    getUnfiledCharacters,
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

/** Current active filter: 'all' | 'present' | 'absent' | 'no-stats' */
let activeFilter = "all";

/** Current search query string */
let searchQuery = "";

/** Current sort mode: 'az' | 'za' | 'present-first' | 'recent' */
let sortMode = "az";

/** Set of folder IDs that are currently collapsed */
const collapsedFolders = new Set();

/** Reference to the currently open context menu element */
let activeCtxMenu = null;

/** Reference to the currently open folder picker element */
let activeFolderPicker = null;

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
            <button class="rst-btn" id="rst-new-folder">+ New folder</button>
            <button class="rst-btn" id="rst-import-chars">Import</button>
            <button class="rst-btn" id="rst-export-chars">Export</button>
        </div>
    `);

    $btnRow.find("#rst-new-char").on("click", () => showNewCharacterDialog($pane));
    $btnRow.find("#rst-new-folder").on("click", () => showNewFolderDialog($pane));
    $btnRow.find("#rst-export-chars").on("click", () => downloadExport());
    $btnRow.find("#rst-import-chars").on("click", () => triggerImport());

    $pane.append($btnRow);

    // Bulk action toolbar
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

        $bulkToolbar.find("#rst-select-all-chars").on("change", function () {
            const checked = $(this).prop("checked");
            $pane.find(".rst-char-select:visible").prop("checked", checked).trigger("change");
        });

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

    // Search bar
    const $searchBar = $(`
        <div class="rst-search-bar">
            <i class="fa-solid fa-search" style="font-size:15px;color:var(--rst-text-muted)" aria-hidden="true"></i>
            <input type="text" id="rst-lib-search" placeholder="Search characters..." value="${searchQuery.replace(/"/g, '"')}">
            <i class="fa-solid fa-xmark rst-search-clear" id="rst-search-clear" style="display:${searchQuery ? '' : 'none'}" title="Clear search"></i>
        </div>
    `);

    const $searchInput = $searchBar.find("#rst-lib-search");
    $searchInput.on("input", function () {
        searchQuery = $(this).val();
        $("#rst-search-clear").toggle(searchQuery.length > 0);
        reRenderCharacterList($pane);
    });

    $searchBar.find("#rst-search-clear").on("click", function () {
        searchQuery = "";
        $searchInput.val("");
        $(this).hide();
        reRenderCharacterList($pane);
        $searchInput.focus();
    });

    $pane.append($searchBar);

    // Filter row + Sort
    const filters = [
        { id: "all", label: "All" },
        { id: "present", label: "Present" },
        { id: "absent", label: "Not present" },
        { id: "no-stats", label: "No stats yet" },
    ];

    const $filterRow = $(`<div class="rst-filter-row"></div>`);
    $filterRow.append('<span style="font-size:11px;color:var(--rst-text-muted);align-self:center">Filter:</span>');

    for (const f of filters) {
        const $chip = $(`<button class="rst-filter-chip${activeFilter === f.id ? " on" : ""}" data-filter="${f.id}">${f.label}</button>`);
        $chip.on("click", function () {
            activeFilter = f.id;
            $filterRow.find(".rst-filter-chip").removeClass("on");
            $(this).addClass("on");
            reRenderCharacterList($pane);
        });
        $filterRow.append($chip);
    }

    // Sort dropdown
    $filterRow.append('<span style="margin-left:auto;font-size:11px;color:var(--rst-text-muted)">Sort:</span>');
    const sortOptions = [
        { id: "az", label: "A → Z" },
        { id: "za", label: "Z → A" },
        { id: "present-first", label: "Present first" },
        { id: "recent", label: "Recently updated" },
    ];

    const $sortSelect = $(`<select id="rst-lib-sort" style="width:130px;font-size:12px;padding:3px 8px"></select>`);
    for (const opt of sortOptions) {
        $sortSelect.append(`<option value="${opt.id}"${sortMode === opt.id ? " selected" : ""}>${opt.label}</option>`);
    }
    $sortSelect.on("change", function () {
        sortMode = $(this).val();
        reRenderCharacterList($pane);
    });
    $filterRow.append($sortSelect);

    $pane.append($filterRow);

    // Character list with folders
    const $listArea = $('<div id="rst-lib-list"></div>');
    $pane.append($listArea);

    renderCharacterList($listArea);

    // Hidden wraps for inline panels
    $pane.append('<div id="rst-wand-wrap" style="display:none;margin-top:8px"></div>');
    $pane.append('<div id="rst-log-wrap" style="display:none;margin-top:4px"></div>');
    $pane.append('<div id="rst-newchar-wrap" style="display:none;margin-top:8px"></div>');

    // Hidden file input for avatar upload
    $pane.append('<input type="file" id="rst-avatar-upload" accept="image/*" style="display:none">');
}

/**
 * Re-render just the character list, preserving card state.
 */
function reRenderCharacterList($pane) {
    selectedCharIds.clear();
    updateBulkToolbar($pane);
    const $listArea = $pane.find("#rst-lib-list");
    renderCharacterList($listArea);
}

/**
 * Select a specific character by ID.
 */
export function selectCharacter(charId) {
    selectedCharId = charId;

    // If the character lives inside a folder, make sure that folder is open —
    // otherwise the selected chip and its profile card render inside a collapsed
    // folder body and stay invisible. (Folders are collapsed by default.)
    const _selProfile = getCharacterProfile(charId);
    if (_selProfile && _selProfile.folderId) {
        collapsedFolders.add(_selProfile.folderId + '_open');
    }

    const $pane = $("#rst-p-lib");
    reRenderCharacterList($pane);

    // Scroll the now-visible character card into view.
    setTimeout(() => {
        const $sel = $pane.find(".rst-chip.on").first();
        if ($sel.length && $sel[0].scrollIntoView) {
            $sel[0].scrollIntoView({ behavior: "smooth", block: "center" });
        }
    }, 60);
}

// ─── Filter/Sort Pipeline ─────────────────────────────────

function getFilteredSortedChars() {
    const chars = getAllCharacters();
    const presentIds = getPresentCharacters();

    let filtered = chars;
    if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        filtered = filtered.filter((c) => c.name.toLowerCase().includes(q));
    }

    if (activeFilter === "present") {
        filtered = filtered.filter((c) => presentIds.includes(c.id));
    } else if (activeFilter === "absent") {
        filtered = filtered.filter((c) => !presentIds.includes(c.id));
    } else if (activeFilter === "no-stats") {
        filtered = filtered.filter((c) => {
            for (const cat of STAT_CATEGORIES) {
                for (const stat of STAT_NAMES) {
                    if (c.stats[cat][stat] !== 0) return false;
                }
            }
            return true;
        });
    }

    if (sortMode === "az") {
        filtered.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortMode === "za") {
        filtered.sort((a, b) => b.name.localeCompare(a.name));
    } else if (sortMode === "present-first") {
        filtered.sort((a, b) => {
            const aPres = presentIds.includes(a.id) ? 0 : 1;
            const bPres = presentIds.includes(b.id) ? 0 : 1;
            if (aPres !== bPres) return aPres - bPres;
            return a.name.localeCompare(b.name);
        });
    } else if (sortMode === "recent") {
        filtered.sort((a, b) => {
            const aTs = getMostRecentTimestamp(a);
            const bTs = getMostRecentTimestamp(b);
            return bTs - aTs;
        });
    }

    return filtered;
}

// ─── Character List (Folders + Unfiled) ───────────────────

function renderCharacterList($container) {
    $container.empty();

    const filteredChars = getFilteredSortedChars();
    const folders = getFolders();
    const presentIds = getPresentCharacters();

    for (const folder of folders) {
        const folderChars = filteredChars.filter((c) => c.folderId === folder.id);
        const isOpen = collapsedFolders.has(folder.id + '_open');
        const count = folderChars.length;

        if (count === 0 && (searchQuery.trim() || activeFilter !== "all")) continue;

        const $folder = $(`<div class="rst-folder${isOpen ? " open" : ""}" data-folder-id="${folder.id}"></div>`);

        const $header = $(`
            <div class="rst-folder-hdr">
                <i class="fa-solid fa-folder" style="font-size:15px;color:var(--rst-accent)" aria-hidden="true"></i>
                <span style="font-weight:500">${folder.name}</span>
                <span class="rst-folder-count">${count} character${count !== 1 ? "s" : ""}</span>
                <i class="fa-solid fa-ellipsis-vertical rst-folder-menu-btn" title="Folder options"></i>
                <i class="fa-solid fa-chevron-down rst-folder-chevron"></i>
            </div>
        `);

        $header.on("click", function (e) {
            if ($(e.target).closest(".rst-folder-menu-btn").length) return;
            const folderId = $folder.data("folder-id");
            if (collapsedFolders.has(folderId + '_open')) {
                collapsedFolders.delete(folderId + '_open');
                $folder.removeClass("open");
            } else {
                collapsedFolders.add(folderId + '_open');
                $folder.addClass("open");
            }
        });

        $header.find(".rst-folder-menu-btn").on("click", function (e) {
            e.stopPropagation();
            showFolderContextMenu(e, folder);
        });
                const $body = $(`<div class="rst-folder-body"></div>`);

        for (const char of folderChars) {
            const $chipWrap = buildCharChip(char, presentIds);
            $body.append($chipWrap);
        }

        $folder.append($header);
        $folder.append($body);
        $container.append($folder);
    }

    const unfiledChars = filteredChars.filter((c) => !c.folderId);
    if (unfiledChars.length > 0 || (searchQuery.trim() === "" && activeFilter === "all")) {
        if (folders.length > 0 && unfiledChars.length > 0) {
            $container.append('<div style="font-size:11px;color:var(--rst-text-muted);padding:8px 0 4px;text-transform:uppercase;letter-spacing:0.05em">Unfiled</div>');
        }

        for (const char of unfiledChars) {
            const $chipWrap = buildCharChip(char, presentIds, true);
            $container.append($chipWrap);
        }
    }

    if (filteredChars.length === 0) {
        $container.append('<div style="font-size:12px;color:var(--rst-text-muted);padding:20px 0;text-align:center">No characters found.</div>');
    }
}

// ─── Character Chip Builder ────────────────────────────────

function buildCharChip(char, presentIds, isUnfiled = false) {
    const initials = getInitials(char.name);
    const isPresent = presentIds.includes(char.id);
    const isSelected = char.id === selectedCharId;

    const $wrap = $(`<div class="rst-chip-wrap"></div>`);

    let avContent = initials;
    if (char.avatar) {
        avContent = `<img src="${char.avatar}" alt="">`;
    }

    const $chip = $(`
        <div class="rst-chip${isSelected ? " on" : ""}${isUnfiled ? " rst-chip-unfiled" : ""}">
            <input type="checkbox" class="rst-char-select" data-char-id="${char.id}" style="margin:0;cursor:pointer;flex-shrink:0" title="Select this character">
            <div class="rst-av">${avContent}</div>
            <div style="min-width:0;flex:1">
                <div style="font-weight:500">${char.name}</div>
                <div style="font-size:11px;color:var(--rst-text-muted)">${isPresent ? '<span class="rst-badge-present">present</span>' : '<span class="rst-badge-absent">not present</span>'}</div>
            </div>
            ${isPresent ? '<div class="rst-dot" style="margin-left:auto"></div>' : ""}
        </div>
    `);

    const $cardWrap = $(`<div class="rst-card-wrap" style="display:${isSelected ? "block" : "none"}"></div>`);

    const $checkbox = $chip.find(".rst-char-select");
    $checkbox.on("change", function () {
        const checked = $(this).prop("checked");
        const charId = $(this).data("char-id");
        if (checked) {
            selectedCharIds.add(charId);
        } else {
            selectedCharIds.delete(charId);
        }
        const $pane = $("#rst-p-lib");
        updateBulkToolbar($pane);
    });

    $chip.on("click", (e) => {
        if ($(e.target).is("input[type=checkbox]")) return;

        if (selectedCharId === char.id) {
            selectedCharId = null;
            $chip.removeClass("on");
            $cardWrap.slideUp(200);
            return;
        }

        const $pane = $("#rst-p-lib");
        $pane.find(".rst-chip.on").removeClass("on");
        $pane.find(".rst-card-wrap:visible").slideUp(200);

        selectedCharId = char.id;
        $chip.addClass("on");

        if ($cardWrap.is(":empty")) {
            const profile = getCharacterProfile(char.id);
            if (profile) {
                renderCharacterCard($cardWrap, profile);
            }
        }

        $cardWrap.slideDown(200);
    });

    // Right-click context menu
    $chip.on("contextmenu", function (e) {
        e.preventDefault();
        if (selectedCharId !== char.id) {
            const $pane = $("#rst-p-lib");
            $pane.find(".rst-chip.on").removeClass("on");
            $pane.find(".rst-card-wrap:visible").slideUp(200);
            selectedCharId = char.id;
            $chip.addClass("on");
            if ($cardWrap.is(":empty")) {
                const profile = getCharacterProfile(char.id);
                if (profile) {
                    renderCharacterCard($cardWrap, profile);
                }
            }
            $cardWrap.slideDown(200);
        }
        showCharContextMenu(e, char);
    });

    $wrap.append($chip);
    $wrap.append($cardWrap);

    if (isSelected) {
        const profile = getCharacterProfile(char.id);
        if (profile) {
            renderCharacterCard($cardWrap, profile);
        }
    }

    return $wrap;
}

// ─── Update Bulk Toolbar ──────────────────────────────────

function updateBulkToolbar($pane) {
    const $toolbar = $pane.find("#rst-delete-selected-chars");
    if ($toolbar.length === 0) return;
    const count = selectedCharIds.size;
    $toolbar.text(`Delete selected (${count})`);
    if (count > 0) {
        $toolbar.prop("disabled", false).css({ opacity: 1, pointerEvents: "auto" });
    } else {
        $toolbar.prop("disabled", true).css({ opacity: 0.5, pointerEvents: "none" });
    }

    const totalCheckboxes = $pane.find(".rst-char-select:visible").length;
    const checkedCheckboxes = $pane.find(".rst-char-select:visible:checked").length;
    const $selectAll = $pane.find("#rst-select-all-chars");
    if ($selectAll.length) {
        $selectAll.prop("checked", totalCheckboxes > 0 && checkedCheckboxes === totalCheckboxes);
    }
}

// ─── Character Display Card ───────────────────────────────

function renderCharacterCard($pane, profile) {
    const initials = getInitials(profile.name);
    const $card = $(`<div class="rst-card"></div>`);

    const folders = getFolders();
    const folder = folders.find((f) => f.id === profile.folderId);
    const folderName = folder ? folder.name : null;
    const hasAvatar = !!profile.avatar;

    let avContent = `<span>${initials}</span>`;
    if (hasAvatar) {
        avContent = `<img src="${profile.avatar}" alt=""><span>${initials}</span>`;
    }

    const $header = $(`
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
            <div style="display:flex;flex-direction:column;align-items:center;gap:4px">
                <div class="rst-av-lg" id="rst-av-lg-${profile.id}" title="Click to upload photo">
                    ${avContent}
                    <div class="rst-av-overlay">
                        <i class="fa-solid fa-camera" style="font-size:18px;color:#fff"></i>
                    </div>
                </div>
                <div class="rst-upload-hint">
                    ${hasAvatar
                        ? '<span class="rst-upload-link" style="cursor:pointer">change</span> · <span class="rst-remove-pic-link" style="cursor:pointer;color:var(--rst-danger)">remove</span>'
                        : 'click to upload'
                    }
                </div>
            </div>
            <div style="flex:1;min-width:0">
                <input type="text" class="rst-char-name" value="${profile.name}"
                    style="font-size:15px;font-weight:500;width:100%;padding:2px 4px">
                <div style="font-size:11px;color:var(--rst-text-muted);margin-top:2px">
                    ${folderName
                        ? `<span class="rst-folder-label" id="rst-folder-label-${profile.id}" title="Click to change folder"><i class="fa-solid fa-folder"></i> ${folderName}</span>`
                        : `<span class="rst-folder-label" id="rst-folder-label-${profile.id}" style="color:var(--rst-text-muted)" title="Click to add to folder"><i class="fa-solid fa-folder"></i> Unfiled</span>`
                    }
                </div>
            </div>
            <div style="margin-left:auto;display:flex;gap:6px">
                <button class="rst-icon-btn rst-wand-btn" title="Generate profile"><i class="fa-solid fa-wand-magic-sparkles"></i></button>
                <button class="rst-icon-btn rst-edit-btn" title="Edit stats"><i class="fa-solid fa-pen"></i></button>
                <button class="rst-icon-btn rst-log-btn" title="Update log"><i class="fa-solid fa-clock-rotate-left"></i></button>
                <button class="rst-icon-btn rst-delete-btn" style="color:var(--rst-danger)" title="Delete character"><i class="fa-solid fa-xmark"></i></button>
            </div>
        </div>
    `);

    $header.find(".rst-av-lg").on("click", function () {
        triggerAvatarUpload(profile);
    });

    $header.find(".rst-upload-link").on("click", function (e) {
        e.stopPropagation();
        triggerAvatarUpload(profile);
    });

    $header.find(".rst-remove-pic-link").on("click", async function (e) {
        e.stopPropagation();
        await removeProfilePicture(profile);
    });

    const $folderLabel = $header.find(`#rst-folder-label-${profile.id}`);
    if ($folderLabel.length) {
        $folderLabel.on("click", function (e) {
            e.stopPropagation();
            showFolderPicker($(this), profile);
        });
    }

    $header.find(".rst-wand-btn").on("click", () => showWandModal(profile));
    $header.find(".rst-edit-btn").on("click", () => showEditStatsModal(profile));
    $header.find(".rst-log-btn").on("click", () => toggleLogPanel(profile));
    $header.find(".rst-delete-btn").on("click", () => confirmDeleteCharacter(profile));

    const $nameInput = $header.find(".rst-char-name");
    $nameInput.on("change", function () {
        const newName = $(this).val().trim();
        if (newName && newName !== profile.name) {
            updateCharacterProfile(profile.id, { name: newName });
            profile.name = newName;
            const $pane = $("#rst-p-lib");
            reRenderCharacterList($pane);
        } else if (!newName) {
            $(this).val(profile.name);
        }
    });

    $card.append($header);

    // Name aliases
    const aliasesStr = (profile.nameAliases && Array.isArray(profile.nameAliases))
        ? profile.nameAliases.join(", ")
        : "";
    const $aliasesRow = $(`
        <div style="margin-bottom:8px">
            <div class="rst-lbl" style="margin-bottom:2px">Name aliases</div>
            <div style="font-size:11px;color:var(--rst-text-muted);margin-bottom:4px;line-height:1.4">
                Alternative names this character is known by (comma-separated). Used by sidecar detection
                to match LLM output (e.g. "Doe") against your library entry (e.g. "John Doe").
            </div>
            <input type="text" class="rst-char-aliases" value="${aliasesStr}"
                style="width:100%;padding:4px 6px;font-size:12px;background:transparent;color:inherit"
                placeholder="e.g. Mr. Doe, John">
        </div>
    `);
    const $aliasesInput = $aliasesRow.find(".rst-char-aliases");
    $aliasesInput.on("change", function () {
        const raw = $(this).val();
        const aliases = raw.split(",").map((s) => s.trim()).filter(Boolean);
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

    // ── Dossier: current dynamic (title + narrative) sits ABOVE the matrix ──
    if (profile.dynamicTitle || profile.narrativeSummary) {
        $card.append('<div class="rst-d-section-lbl">Current dynamic</div>');
        if (profile.dynamicTitle) {
            $card.append(`<div class="rst-d-title">${profile.dynamicTitle}</div>`);
        }
        if (profile.narrativeSummary) {
            $card.append(`<div class="rst-d-narr">${profile.narrativeSummary}</div>`);
        }
    }

    // ── Dossier: relationship matrix ──
    $card.append('<div class="rst-d-section-lbl" style="margin-top:14px">Relationship matrix</div>');
    const $matrix = $('<div class="rst-d-matrix"></div>');
    for (const cat of STAT_CATEGORIES) {
        $matrix.append(renderStatCategoryForLibrary(cat, profile));
    }
    $card.append($matrix);

    $pane.append($card);
}

// ─── Profile Picture: Upload, Crop, Remove ────────────────

function triggerAvatarUpload(profile) {
    const $input = $("#rst-avatar-upload");
    if ($input.length === 0) return;

    $input.data("profile-id", profile.id);

    $input.off("change").on("change", function () {
        const file = this.files[0];
        if (!file) return;
        const charId = $input.data("profile-id");
        if (charId) {
            showCropDialog(file, charId);
        }
        this.value = "";
    });

    $input[0].click();
}

/**
 * Show the crop dialog for a selected image file.
 * Supports drag-to-reposition AND corner-drag-to-resize the crop square.
 */
async function showCropDialog(file, charId) {
    const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });

    const cropId = "rst-crop-" + Date.now();

    // Crop state
    const cropState = { left: 0, top: 0, size: 0, displayW: 0, displayH: 0, ready: false };
    let imgEl = null;

    // Handle types: null (move), or "nw"/"ne"/"sw"/"se" (resize from that corner)
    const html = `
        <h3>Crop Profile Picture</h3>
        <p style="font-size:12px;color:var(--SmartThemeBodyColor,#999);margin-bottom:8px">
            Drag to reposition. Drag corners to resize.
        </p>
        <div id="${cropId}-wrap" style="position:relative;overflow:hidden;background:#111;border-radius:4px;user-select:none;margin:0 auto">
            <img id="${cropId}-img" src="${dataUrl}" style="display:block;max-width:100%;pointer-events:none" draggable="false">
            <div id="${cropId}-overlay" style="position:absolute;border:2px dashed #fff;box-shadow:0 0 0 9999px rgba(0,0,0,0.5);pointer-events:none;box-sizing:border-box"></div>
            <div id="${cropId}-h-nw" class="rst-crop-handle" style="position:absolute;width:14px;height:14px;background:#fff;border:2px solid #333;cursor:nwse-resize;z-index:2"></div>
            <div id="${cropId}-h-ne" class="rst-crop-handle" style="position:absolute;width:14px;height:14px;background:#fff;border:2px solid #333;cursor:nesw-resize;z-index:2"></div>
            <div id="${cropId}-h-sw" class="rst-crop-handle" style="position:absolute;width:14px;height:14px;background:#fff;border:2px solid #333;cursor:nesw-resize;z-index:2"></div>
            <div id="${cropId}-h-se" class="rst-crop-handle" style="position:absolute;width:14px;height:14px;background:#fff;border:2px solid #333;cursor:nwse-resize;z-index:2"></div>
        </div>
    `;

    function positionHandles($handles) {
        const hw = 7; // half handle width
        $handles.nw.css({ left: (cropState.left - hw) + "px", top: (cropState.top - hw) + "px" });
        $handles.ne.css({ left: (cropState.left + cropState.size - hw) + "px", top: (cropState.top - hw) + "px" });
        $handles.sw.css({ left: (cropState.left - hw) + "px", top: (cropState.top + cropState.size - hw) + "px" });
        $handles.se.css({ left: (cropState.left + cropState.size - hw) + "px", top: (cropState.top + cropState.size - hw) + "px" });
    }

    /** Perform the actual crop using current cropState */
    function doCrop() {
        if (!cropState.ready || !imgEl) return dataUrl;
        const canvas = document.createElement("canvas");
        canvas.width = cropState.size;
        canvas.height = cropState.size;
        const ctx = canvas.getContext("2d");
        const scaleX = imgEl.naturalWidth / cropState.displayW;
        const scaleY = imgEl.naturalHeight / cropState.displayH;
        ctx.drawImage(
            imgEl,
            Math.round(cropState.left * scaleX),
            Math.round(cropState.top * scaleY),
            Math.round(cropState.size * scaleX),
            Math.round(cropState.size * scaleY),
            0, 0,
            cropState.size, cropState.size
        );
        return canvas.toDataURL("image/jpeg", 0.85);
    }

    const popup = new Popup(html, POPUP_TYPE.TEXT, "", {
        customButtons: [
            {
                text: "Skip crop",
                result: 1,
                action: async () => {
                    updateCharacterProfile(charId, { avatar: dataUrl });
                    toastr?.success?.("Profile picture updated.");
                    renderLibraryTab($("#rst-p-lib"));
                    popup.complete(1);
                },
            },
            {
                text: "Crop & Save",
                result: 2,
                action: async () => {
                    const cropped = doCrop();
                    updateCharacterProfile(charId, { avatar: cropped });
                    toastr?.success?.("Profile picture saved.");
                    renderLibraryTab($("#rst-p-lib"));
                    popup.complete(2);
                },
            },
        ],
        okButton: "Cancel",
    });

    // Wire up the crop UI after the dialog DOM is rendered
    setTimeout(() => {
        const $dialog = $("dialog.popup").last();
        if (!$dialog.length) return;

        const $wrap = $dialog.find(`#${cropId}-wrap`);
        const $img = $dialog.find(`#${cropId}-img`);
        const $overlay = $dialog.find(`#${cropId}-overlay`);
        const $handles = {
            nw: $dialog.find(`#${cropId}-h-nw`),
            ne: $dialog.find(`#${cropId}-h-ne`),
            sw: $dialog.find(`#${cropId}-h-sw`),
            se: $dialog.find(`#${cropId}-h-se`),
        };

        if (!$img.length || !$wrap.length) return;
        imgEl = $img[0];

        const setupCrop = () => {
            cropState.displayW = imgEl.clientWidth;
            cropState.displayH = imgEl.clientHeight;
            cropState.size = Math.min(cropState.displayW, cropState.displayH, 260);
            cropState.left = (cropState.displayW - cropState.size) / 2;
            cropState.top = (cropState.displayH - cropState.size) / 2;
            cropState.ready = true;

            $overlay.css({
                left: cropState.left + "px",
                top: cropState.top + "px",
                width: cropState.size + "px",
                height: cropState.size + "px",
            });
            positionHandles($handles);

            // ── Drag states ──
            let action = null; // null | 'move' | 'resize-nw' | 'resize-ne' | 'resize-sw' | 'resize-se'
            let dragStartX = 0, dragStartY = 0;
            let origLeft = 0, origTop = 0, origSize = 0;

            function clampSize(val) {
                return Math.max(40, Math.min(cropState.displayW, cropState.displayH, val));
            }

            // Move: mousedown on the wrap itself (not handles)
            $wrap.on("mousedown", function (e) {
                if ($(e.target).closest(".rst-crop-handle").length) return; // let handles handle it
                action = "move";
                dragStartX = e.clientX;
                dragStartY = e.clientY;
                origLeft = cropState.left;
                origTop = cropState.top;
                e.preventDefault();
            });

            // Resize: mousedown on handles
            Object.entries($handles).forEach(([corner, $h]) => {
                $h.on("mousedown", function (e) {
                    action = "resize-" + corner;
                    dragStartX = e.clientX;
                    dragStartY = e.clientY;
                    origLeft = cropState.left;
                    origTop = cropState.top;
                    origSize = cropState.size;
                    e.preventDefault();
                    e.stopPropagation();
                });
            });

            $(document).on("mousemove.rst-crop", function (e) {
                if (!action) return;
                const dx = e.clientX - dragStartX;
                const dy = e.clientY - dragStartY;

                if (action === "move") {
                    cropState.left = Math.max(0, Math.min(cropState.displayW - cropState.size, origLeft + dx));
                    cropState.top = Math.max(0, Math.min(cropState.displayH - cropState.size, origTop + dy));
                } else if (action === "resize-nw") {
                    // Fixed: bottom-right corner. New size = old size - max(dx, dy) (keep square)
                    const delta = Math.max(dx, dy); // both negative when dragging nw
                    const newSize = clampSize(origSize - delta);
                    cropState.size = newSize;
                    cropState.left = origLeft + origSize - newSize;
                    cropState.top = origTop + origSize - newSize;
                } else if (action === "resize-ne") {
                    const delta = Math.max(-dx, dy); // dx positive, dy negative → size change
                    const newSize = clampSize(origSize + delta);
                    cropState.size = newSize;
                    // Keep top fixed; left stays at origLeft
                    cropState.top = origTop + origSize - newSize;
                    // left stays: actually for ne, left is fixed, top moves. NewSize affects top.
                    // Correct: left fixed, right expands. Left=origLeft, top=origTop + origSize - newSize
                } else if (action === "resize-sw") {
                    const delta = Math.max(dx, -dy);
                    const newSize = clampSize(origSize + delta);
                    cropState.size = newSize;
                    // left is fixed (origLeft), bottom expands. top=origTop
                    cropState.left = origLeft + origSize - newSize;
                } else if (action === "resize-se") {
                    const delta = Math.max(dx, dy);
                    const newSize = clampSize(origSize + delta);
                    cropState.size = newSize;
                    // left and top stay fixed
                }

                // Clamp final position
                cropState.left = Math.max(0, Math.min(cropState.displayW - cropState.size, cropState.left));
                cropState.top = Math.max(0, Math.min(cropState.displayH - cropState.size, cropState.top));

                $overlay.css({
                    left: cropState.left + "px",
                    top: cropState.top + "px",
                    width: cropState.size + "px",
                    height: cropState.size + "px",
                });
                positionHandles($handles);
            });

            $(document).on("mouseup.rst-crop", function () {
                action = null;
            });
        };

        if (imgEl.complete && imgEl.naturalWidth > 0) {
            setupCrop();
        } else {
            $img.on("load.rst-crop", setupCrop);
        }
    }, 100);

    await popup.show();

    $(document).off("mousemove.rst-crop");
    $(document).off("mouseup.rst-crop");
}

/**
 * Remove the profile picture for a character.
 */
async function removeProfilePicture(profile) {
    const confirmed = await Popup.show.confirm(
        "Remove Profile Picture",
        `Remove ${profile.name}'s profile picture?`
    );
    if (!confirmed) return;

    updateCharacterProfile(profile.id, { avatar: null });
    profile.avatar = null;
    toastr?.success?.("Profile picture removed.");
    const $pane = $("#rst-p-lib");
            reRenderCharacterList($pane);
}

// ─── Folder Picker ────────────────────────────────────────

function showFolderPicker($anchor, profile) {
    closeFolderPicker();

    const folders = getFolders();
    const $picker = $(`<div class="rst-folder-picker show"></div>`);

    buildPickerItems($picker, folders, profile);

    // Append inside the RST panel/popout so the picker is contained
    // within the same stacking context and clicks don't fall through
    // to ST UI elements (like the toolbar puzzle icon) behind the popup.
    const $rstRoot = $('#rst-popout-content').length
        ? $('#rst-popout-content')
        : $('#rst_container');
    $rstRoot.append($picker);
    $picker.css({ position: 'absolute' });

    const anchorRect = $anchor[0].getBoundingClientRect();
    const rootRect = $rstRoot[0].getBoundingClientRect();
    const pickerW = 160;
    const pickerH = 200;
    let left = anchorRect.left - rootRect.left;
    let top = anchorRect.bottom - rootRect.top + 4;
    if (left + pickerW > rootRect.width) left = rootRect.width - pickerW - 4;
    if (left < 0) left = 0;
    $picker.css({ left, top });

    activeFolderPicker = $picker[0];

    // Register dismiss handler immediately (not in setTimeout) so it is active
    // before the current click finishes bubbling. Use a flag to ignore the
    // triggering click itself — without this the picker closes instantly.
    let skipFirst = true;
    $(document).on("click.rst-folder-picker", function (e) {
        if (skipFirst) { skipFirst = false; return; }
        if ($(e.target).closest(".rst-folder-picker").length) {
            e.stopPropagation();
            return;
        }
        if (!$(e.target).closest(".rst-folder-label").length) {
            closeFolderPicker();
        }
    });
}

/**
 * Show the folder picker at a specific screen position (used from context menus).
 */
function showFolderPickerAt(x, y, char) {
    closeFolderPicker();

    const folders = getFolders();
    const $picker = $(`<div class="rst-folder-picker show"></div>`);

    buildPickerItems($picker, folders, char);

    const $rstRoot2 = $('#rst-popout-content').length
        ? $('#rst-popout-content')
        : $('#rst_container');
    $rstRoot2.append($picker);
    $picker.css({ position: 'absolute' });

    const rootRect2 = $rstRoot2[0].getBoundingClientRect();
    let left2 = x - rootRect2.left;
    let top2 = y - rootRect2.top;
    const pickerW2 = 160;
    const pickerH2 = 200;
    if (left2 + pickerW2 > rootRect2.width) left2 = rootRect2.width - pickerW2 - 4;
    if (top2 + pickerH2 > rootRect2.height) top2 = top2 - pickerH2 - 4;
    if (left2 < 0) left2 = 0;
    $picker.css({ left: left2, top: top2 });

    activeFolderPicker = $picker[0];

    let skipFirst2 = true;
    $(document).on("click.rst-folder-picker", function (e) {
        if (skipFirst2) { skipFirst2 = false; return; }
        if ($(e.target).closest(".rst-folder-picker").length) {
            e.stopPropagation();
            return;
        }
        closeFolderPicker();
    });
}

/**
 * Build folder picker items into a container.
 */
function buildPickerItems($container, folders, profile) {
    for (const folder of folders) {
        const isCurrent = profile.folderId === folder.id;
        const $item = $(`<div class="rst-folder-pick-item${isCurrent ? " on" : ""}" data-folder-id="${folder.id}">
            <i class="fa-solid fa-folder" style="font-size:12px;color:var(--rst-accent);margin-right:6px"></i>${folder.name}
            ${isCurrent ? '<span style="margin-left:auto;font-size:11px;color:var(--rst-avatar-text)">✓</span>' : ""}
        </div>`);

        $item.on("click", function (e) {
            e.stopPropagation();
            e.stopImmediatePropagation();
            const folderId = $(this).data("folder-id");
            $(document).off("click.rst-folder-picker");
            moveCharToFolder(profile.id, folderId);
            profile.folderId = folderId;
            closeFolderPicker();
            setTimeout(() => { const $pane = $("#rst-p-lib"); reRenderCharacterList($pane); }, 0);
            toastr?.success?.("Character moved to folder.");
        });

        $container.append($item);
    }

    const isUnfiled = !profile.folderId;
    const $unfiledItem = $(`<div class="rst-folder-pick-item${isUnfiled ? " on" : ""}">
        <i class="fa-solid fa-folder-open" style="font-size:12px;color:var(--rst-text-muted);margin-right:6px"></i>Unfiled
        ${isUnfiled ? '<span style="margin-left:auto;font-size:11px;color:var(--rst-avatar-text)">✓</span>' : ""}
    </div>`);

    $unfiledItem.on("click", function (e) {
        e.stopPropagation();
        e.stopImmediatePropagation();
        $(document).off("click.rst-folder-picker");
        moveCharToFolder(profile.id, null);
        profile.folderId = null;
        closeFolderPicker();
        setTimeout(() => { const $pane = $("#rst-p-lib"); reRenderCharacterList($pane); }, 0);
        toastr?.success?.("Character moved to unfiled.");
    });

    $container.append($unfiledItem);
}

function closeFolderPicker() {
    $(document).off("click.rst-folder-picker");
    if (activeFolderPicker) {
        $(activeFolderPicker).remove();
        activeFolderPicker = null;
    }
}

// ─── Context Menus ────────────────────────────────────────

function showCharContextMenu(e, char) {
    closeContextMenu();
    closeFolderPicker();

    const $menu = $(`<div class="rst-ctx-menu show"></div>`);

    // Move to folder — opens standalone folder picker at cursor position
    const $moveItem = $(`<div class="rst-ctx-item">
        <i class="fa-solid fa-folder" style="font-size:14px;color:var(--rst-text-muted)"></i>Move to folder
        <i class="fa-solid fa-chevron-right" style="margin-left:auto;font-size:11px;color:var(--rst-text-muted)"></i>
    </div>`);
    $moveItem.on("click", function (evt) {
        evt.stopPropagation();
        $(document).off("click.rst-ctx-menu");
        $(document).off("click.rst-folder-picker");
        closeContextMenu();
        showFolderPickerAt(e.clientX, e.clientY, char);
    });
    $menu.append($moveItem);

    // Delete character
    $menu.append('<div class="rst-ctx-divider"></div>');
    const $deleteItem = $(`<div class="rst-ctx-item" style="color:var(--rst-danger)">
        <i class="fa-solid fa-trash" style="font-size:14px"></i>Delete character
    </div>`);
    $deleteItem.on("click", async function () {
        closeContextMenu();
        await confirmDeleteCharacter(char);
    });
    $menu.append($deleteItem);

    $("body").append($menu);
    activeCtxMenu = $menu[0];
    requestAnimationFrame(() => {
        const btnRect = e.target.getBoundingClientRect();
        const menuH = $menu.outerHeight() || 200;
        let menuLeft = btnRect.right - 170;
        let menuTop = btnRect.bottom + 4;
        if (menuTop + menuH > window.innerHeight) menuTop = btnRect.top - menuH - 4;
        if (menuLeft < 0) menuLeft = 4;
        $menu.css({ left: menuLeft, top: menuTop });
        $menu.addClass("show");
    });

    let skipFirstCtx = true;
    $(document).on("click.rst-ctx-menu", function (evt) {
        if (skipFirstCtx) { skipFirstCtx = false; return; }
        if ($(evt.target).closest(".rst-ctx-menu").length) {
            evt.stopPropagation();
            return;
        }
        $(document).off("click.rst-ctx-menu");
        closeContextMenu();
    });
}

function showFolderContextMenu(e, folder) {
    closeContextMenu();
    closeFolderPicker();

    const $menu = $(`<div class="rst-ctx-menu show"></div>`);

    const $renameItem = $(`<div class="rst-ctx-item">
        <i class="fa-solid fa-pen" style="font-size:14px;color:var(--rst-text-muted)"></i>Rename folder
    </div>`);
    $renameItem.on("click", async function () {
        closeContextMenu();
        const newName = await Popup.show.input("Rename folder", "Enter new folder name:", folder.name);
        if (newName && newName.trim() && newName.trim() !== folder.name) {
            renameFolder(folder.id, newName.trim());
            const $pane = $("#rst-p-lib");
            reRenderCharacterList($pane);
        }
    });
    $menu.append($renameItem);
    // Move Up / Move Down
    const $moveUpItem = $(`<div class="rst-ctx-item"><i class="fa-solid fa-arrow-up" style="font-size:14px;color:var(--rst-text-muted)"></i>Move Up</div>`);
    $moveUpItem.on("click", function () {
        closeContextMenu();
        const allFolders = getFolders();
        const idx = allFolders.findIndex(f => f.id === folder.id);
        if (idx > 0) { const [moved] = allFolders.splice(idx, 1); allFolders.splice(idx - 1, 0, moved); saveFolders(allFolders); const $pane = $("#rst-p-lib"); reRenderCharacterList($pane); }
    });
    $menu.append($moveUpItem);

    const $moveDownItem = $(`<div class="rst-ctx-item"><i class="fa-solid fa-arrow-down" style="font-size:14px;color:var(--rst-text-muted)"></i>Move Down</div>`);
    $moveDownItem.on("click", function () {
        closeContextMenu();
        const allFolders = getFolders();
        const idx = allFolders.findIndex(f => f.id === folder.id);
        if (idx >= 0 && idx < allFolders.length - 1) { const [moved] = allFolders.splice(idx, 1); allFolders.splice(idx + 1, 0, moved); saveFolders(allFolders); const $pane = $("#rst-p-lib"); reRenderCharacterList($pane); }
    });
    $menu.append($moveDownItem);


    $menu.append('<div class="rst-ctx-divider"></div>');
    const $deleteItem = $(`<div class="rst-ctx-item" style="color:var(--rst-danger)">
        <i class="fa-solid fa-trash" style="font-size:14px"></i>Delete folder
    </div>`);
    $deleteItem.on("click", async function () {
        closeContextMenu();
        await confirmDeleteFolder(folder);
    });
    $menu.append($deleteItem);

    $("body").append($menu);
    activeCtxMenu = $menu[0];
    requestAnimationFrame(() => {
        const btnRect = e.target.getBoundingClientRect();
        const menuH = $menu.outerHeight() || 200;
        let menuLeft = btnRect.right - 170;
        let menuTop = btnRect.bottom + 4;
        if (menuTop + menuH > window.innerHeight) menuTop = btnRect.top - menuH - 4;
        if (menuLeft < 0) menuLeft = 4;
        $menu.css({ left: menuLeft, top: menuTop });
        $menu.addClass("show");
    });

    let skipFirstFCtx = true;
    $(document).on("click.rst-ctx-menu", function (evt) {
        if (skipFirstFCtx) { skipFirstFCtx = false; return; }
        if ($(evt.target).closest(".rst-ctx-menu").length || $(evt.target).closest(".rst-folder-menu-btn").length) {
            evt.stopPropagation();
            return;
        }
        closeContextMenu();
    });
}

function closeContextMenu() {
    $(document).off("click.rst-ctx-menu");
    if (activeCtxMenu) {
        $(activeCtxMenu).remove();
        activeCtxMenu = null;
    }
}

// ─── Folder Deletion Confirmation ─────────────────────────

async function confirmDeleteFolder(folder) {
    const charsInFolder = getCharactersInFolder(folder.id);
    const count = charsInFolder.length;

    if (count === 0) {
        deleteFolderAndEject(folder.id);
        toastr?.info?.(`Folder "${folder.name}" deleted.`);
        const $pane = $("#rst-p-lib");
            reRenderCharacterList($pane);
        return;
    }

    const confirmed = await Popup.show.confirm(
        "Delete Folder",
        `Delete folder "${folder.name}"?\n\n${count} character${count > 1 ? "s" : ""} will be ejected to unfiled status. No character data will be lost.`
    );

    if (!confirmed) return;

    const ejected = deleteFolderAndEject(folder.id);
    toastr?.success?.(`Folder deleted. ${ejected} character${ejected !== 1 ? "s" : ""} moved to unfiled.`);
    const $pane = $("#rst-p-lib");
            reRenderCharacterList($pane);
}

// ─── New Folder Dialog ────────────────────────────────────

async function showNewFolderDialog($pane) {
    const name = await Popup.show.input("New folder", "Enter folder name:");
    if (!name || !name.trim()) return;

    createFolder(name.trim());
    toastr?.success?.(`Folder "${name.trim()}" created.`);
    reRenderCharacterList($pane);
}

// ─── Stat Category Render ─────────────────────────────────

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
    const catIcon = cat === "platonic" ? "fa-user-group"
        : cat === "romantic" ? "fa-heart"
        : "fa-fire";
    const $cat = $(`<div class="rst-d-cat"></div>`);
    $cat.append(`<div class="rst-d-cat-h"><i class="fa-solid ${catIcon}"></i> ${catTitle}</div>`);

    for (const stat of STAT_NAMES) {
        const val = profile.stats[cat][stat];
        const cls = val > 0 ? "p" : val < 0 ? "n" : "z";
        const commentary = findLatestCommentary(profile, cat, stat);
        const statLabel = stat.charAt(0).toUpperCase() + stat.slice(1);
        const sign = val >= 0 ? "+" : "";

        // mini bar: grows right from center for positive, left for negative
        const pct = Math.min(Math.abs(val) / 2, 50); // 100% maps to half the track
        const fillStyle = val >= 0
            ? `left:50%;width:${pct}%;background:var(--rst-pos,#1D9E75)`
            : `right:50%;width:${pct}%;background:var(--rst-neg,#D85A30)`;
        const barFill = val === 0 ? "" : `<div class="rst-d-track-fill" style="${fillStyle}"></div>`;

        const $stat = $(`
            <div class="rst-d-stat">
                <div class="rst-d-stat-top">
                    <span class="rst-d-stat-name">${statLabel}</span>
                    <div class="rst-d-track">${barFill}</div>
                    <span class="rst-d-stat-val ${cls}">${sign}${val}%</span>
                </div>
                ${commentary ? `<div class="rst-d-stat-com">${commentary}</div>` : ""}
            </div>
        `);
        $cat.append($stat);
    }

    return $cat;
}

// ─── Update Log Panel ─────────────────────────────────────

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

function renderLogEntry(entry, profile) {
    const sceneNum = entry.sceneId?.replace("scene_", "") || "?";
    const timeAgo = formatTimeAgo(entry.timestamp);
    const msgRange = (entry.messageRange && typeof entry.messageRange.start === "number") ? `msgs ${entry.messageRange.start}–${entry.messageRange.end}` : null;

    const $entry = $(`<div class="rst-log-entry"></div>`);

    // ── Entry header: scene number + meta + net change summary ──
    const sourceLabel = entry.source === "batch_scan" ? "batch scan"
        : entry.source === "manual_edit" ? "manual edit"
        : entry.source === "scene_close" ? "scene close"
        : "";
    const metaBits = [msgRange, timeAgo, sourceLabel].filter(Boolean).join(" · ");

    // Count how many stats actually changed
    let changedCount = 0;
    for (const cat of STAT_CATEGORIES) {
        for (const stat of STAT_NAMES) {
            const b = entry.statsBefore?.[cat]?.[stat];
            const a = entry.statsAfter?.[cat]?.[stat];
            if (a === undefined) continue;
            if ((b !== undefined && b !== a) || (b === undefined && a !== 0)) changedCount++;
        }
    }

    $entry.append(`
        <div class="rst-log-head">
            <div class="rst-log-scene">Scene ${sceneNum}</div>
            <div class="rst-log-meta">${metaBits}</div>
            <div class="rst-log-changecount">${changedCount} change${changedCount === 1 ? "" : "s"}</div>
        </div>
    `);

    // Optional dynamic title transition
    if (entry.dynamicTitleBefore && entry.dynamicTitleAfter && entry.dynamicTitleBefore !== entry.dynamicTitleAfter) {
        $entry.append(`
            <div class="rst-log-dyn">
                <span class="rst-log-dyn-from">${entry.dynamicTitleBefore}</span>
                <i class="fa-solid fa-arrow-right-long" style="font-size:10px;opacity:0.6;margin:0 6px"></i>
                <span class="rst-log-dyn-to">${entry.dynamicTitleAfter}</span>
            </div>
        `);
    }

    // ── Per-category grouped changes ──
    const $changes = $('<div class="rst-log-changes"></div>');
    for (const cat of STAT_CATEGORIES) {
        const catTitle = cat.charAt(0).toUpperCase() + cat.slice(1);
        const catIcon = cat === "platonic" ? "fa-user-group" : cat === "romantic" ? "fa-heart" : "fa-fire";

        // Gather changed stats in this category
        const rows = [];
        for (const stat of STAT_NAMES) {
            const before = entry.statsBefore?.[cat]?.[stat];
            const after = entry.statsAfter?.[cat]?.[stat];
            if (after === undefined) continue;

            let changed = false, delta = "", cls = "z";
            if (before !== undefined && before !== after) {
                changed = true;
                cls = after > before ? "p" : "n";
                const diff = after - before;
                delta = `${before}% → ${after}% (${diff > 0 ? "+" : ""}${diff})`;
            } else if (before === undefined && after !== 0) {
                changed = true;
                cls = after > 0 ? "p" : "n";
                delta = `set to ${after}%`;
            }
            if (!changed) continue;

            const statTitle = stat.charAt(0).toUpperCase() + stat.slice(1);
            const commentary = entry.commentary?.[cat]?.[stat] || "";
            const isCritical = Array.isArray(entry.criticalStats) && entry.criticalStats.includes(cat + "." + stat);
            rows.push({ statTitle, delta, cls, commentary, isCritical });
        }

        if (rows.length === 0) continue;

        const $catGroup = $(`<div class="rst-log-cat"><div class="rst-log-cat-h"><i class="fa-solid ${catIcon}"></i> ${catTitle}</div></div>`);
        for (const r of rows) {
            $catGroup.append(`
                <div class="rst-log-stat">
                    <div class="rst-log-stat-top">
                        <span class="rst-log-stat-name">${r.statTitle}${r.isCritical ? ' <span class="rst-log-crit"><i class="fa-solid fa-bolt"></i> critical</span>' : ''}</span>
                        <span class="rst-log-stat-delta ${r.cls}">${r.delta}</span>
                    </div>
                    ${r.commentary ? `<div class="rst-log-stat-com">${r.commentary}</div>` : ""}
                </div>
            `);
        }
        $changes.append($catGroup);
    }

    if (changedCount === 0) {
        $changes.append('<div class="rst-log-nochange">No stat changes recorded for this entry.</div>');
    }
    $entry.append($changes);

    const $btnRow = $(`
        <div class="rst-btn-row" style="margin-top:10px">
            <button class="rst-btn rst-rollback-btn"><i class="fa-solid fa-rotate-left" style="font-size:10px;margin-right:4px"></i>Rollback</button>
            <button class="rst-btn-danger rst-delete-log-btn"><i class="fa-solid fa-trash" style="font-size:10px;margin-right:4px"></i>Delete</button>
        </div>
    `);

    $btnRow.find(".rst-rollback-btn").on("click", () => {
        showRollbackConfirmation(profile, entry);
    });

    $btnRow.find(".rst-delete-log-btn").on("click", () => {
        removeUpdateLogEntryByTimestamp(profile.id, entry.timestamp);
        toastr?.success?.("Log entry deleted.");
        const $pane = $("#rst-p-lib");
            reRenderCharacterList($pane);
    });

    $entry.append($btnRow);
    return $entry;
}

// ─── Rollback Confirmation ────────────────────────────────

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
        if (hasStatsBefore) {
            updateCharacterStats(profile.id, entry.statsBefore);
        }

        const profileUpdates = {};
        if (entry.dynamicTitleBefore) {
            profileUpdates.dynamicTitle = entry.dynamicTitleBefore;
        }
        profileUpdates.narrativeSummary = entry.narrativeSummary ?? "";
        updateCharacterProfile(profile.id, profileUpdates);

        const sceneRef = entry.sceneId && entry.sceneId !== "" ? entry.sceneId : "manual edit";
        const sourceRef = entry.source || sceneRef;

        removeUpdateLogEntryByTimestamp(profile.id, entry.timestamp);

        toastr?.success?.(
            hasStatsBefore
                ? `Rollback complete. ${profile.name} stats restored to pre-${sourceRef} state.`
                : `Log entry removed. ${profile.name} stats left unchanged (no previous stats to restore).`
        );

        const $pane = $("#rst-p-lib");
            reRenderCharacterList($pane);

        const { updateInjection } = await import("../inject/promptInjector.js");
        updateInjection();
    } catch (err) {
        console.error("[RST] Rollback failed:", err);
        toastr?.error?.("Rollback failed. Please try again.");
    }
}

// ─── Edit Stats Modal ───────────────────────────────────────

async function showEditStatsModal(profile) {
    const catTitle = (cat) => cat.charAt(0).toUpperCase() + cat.slice(1);
    const statLabel = (s) => s.charAt(0).toUpperCase() + s.slice(1);

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

                    const titleInput = document.getElementById("rst-lib-edit-title");
                    const narrativeInput = document.getElementById("rst-lib-edit-narrative");
                    const newTitle = titleInput?.value || "";
                    const newNarrative = narrativeInput?.value || "";

                    const oldStats = cloneStats(profile.stats);

                    updateCharacterStats(profile.id, newStats);

                    updateCharacterProfile(profile.id, {
                        dynamicTitle: newTitle,
                        narrativeSummary: newNarrative,
                    });

                    addUpdateLogEntry(profile.id, {
                        statsBefore: oldStats,
                        statsAfter: newStats,
                        commentary: newCommentary,
                        source: "manual_edit",
                        timestamp: Date.now(),
                    });

                    toastr?.success?.(`${profile.name} stats updated.`);

                    const $pane = $("#rst-p-lib");
            reRenderCharacterList($pane);
                    popup.complete(1);
                },
            },
        ],
        okButton: "Cancel",
    });

    await popup.show();
}

// ─── Wand Modal (Profile Generation) ─────────────────────

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

async function runProfileGen(name, prompt, fromScene) {
    showPanelLoading(`Generating profile for ${name}...`);
    try {
        const result = await generateProfile(name, prompt, fromScene);

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
            reRenderCharacterList($pane);
        }
    } catch (err) {
        console.error("[RST] Profile generation failed:", err);
    } finally {
        hidePanelLoading();
    }
}

// ─── New Character Dialog ─────────────────────────────────

async function showNewCharacterDialog($pane) {
    const name = await Popup.show.input("New character", "Enter character name:");
    if (!name || !name.trim()) return;

    createCharacter(name.trim());
    selectedCharId = null;
    toastr?.success?.(`New character profile created for ${name.trim()}.`);
    renderLibraryTab($pane);
}

export async function showNewCharacterDetected(name) {
    const result = await Popup.show.confirm(
        "New character detected",
        `${name} was found in the current context. Create a blank profile entry?`,
        { okButton: "Create entry", cancelButton: "Ignore" },
    );

    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return false;
    }

    createCharacter(name);
    toastr?.success?.(`New character profile created for ${name}.`);
    const $pane = $("#rst-p-lib");
            reRenderCharacterList($pane);
    return true;
}

// ─── Delete Character ─────────────────────────────────────

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
            reRenderCharacterList($pane);
}

// ─── Import/Export ────────────────────────────────────────

function downloadExport() {
    const data = exportCharacters();
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const charName = String(getContext()?.name2 || "chat").replace(/[^a-zA-Z0-9 _-]/g, "").trim().replace(/\s+/g, "_") || "chat";
    a.download = `rst-characters-${charName}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toastr?.success?.("Character data exported.");
}

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
            reRenderCharacterList($pane);
        } else {
            toastr?.error?.(`Failed to import character data.\n${errors.join("\n")}`);
        }
    };
    input.click();
}
