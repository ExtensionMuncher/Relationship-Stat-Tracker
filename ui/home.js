/**
 * home.js — Home tab: toggle, pending updates, present characters
 * Renders the Home tab with pending update cards and present character list
 */

import { getPendingUpdates, savePendingUpdates, getPresentCharacters, savePresentCharacters, getSettings, deleteCharacterData } from "../data/storage.js";
import { getCharacterProfile, getInitials, getAllCharacters, updateCharacterProfile, STAT_CATEGORIES, STAT_NAMES } from "../data/characters.js";
import { getOpenScene, getSceneById, deleteScene, updateSceneSummary, updateSceneTitle } from "../data/scenes.js";
import { generateStatUpdate } from "../llm/statUpdate.js";
import { renderScenesTab } from "./scenes.js";
import { renderLibraryTab } from "./library.js";
import { switchTab, getPane, showPanelLoading, hidePanelLoading } from "./panel.js";
import { Popup, POPUP_RESULT, POPUP_TYPE } from "../../../../../scripts/popup.js";
import { dlog } from "../lib/debug.js";

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

    // Per-character pending updates — skip entries with 0 changes (no actual stat changes to review)
    if (pending.characterUpdates) {
        const meaningfulUpdates = pending.characterUpdates.filter(u => u.changeCount > 0);
        if (meaningfulUpdates.length === 0) {
            $section.append(`<div style="font-size:12px;color:var(--rst-text-muted);padding:12px 0">No stat changes detected for any characters.</div>`);
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
    $card.append(`<div style="font-size:12px;font-weight:500;margin-bottom:8px;color:var(--rst-text-muted)">
        <span>Proposed scene summary</span>
        <i class="editor_maximize fa-solid fa-maximize right_menu_button" data-for="rst-edit-scene-summary" title="Expand the editor"></i>
    </div>`);

    const $textarea = $(`<textarea id="rst-edit-scene-summary" rows="3" style="margin-bottom:8px">${pending.sceneSummary || ""}</textarea>`);
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
        const summary = $textarea.val();
        pending.sceneSummary = summary;
        savePendingUpdates(pending);
        // Also persist to the scene data
        updateSceneSummary(pending.sceneId, summary);
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
            <button class="rst-btn rst-btn-danger" style="margin-left:auto">Dismiss</button>
        </div>
    `);

    const $regenBox = renderRegenBox(`regen-${charUpdate.characterId}`, async (guidance) => {
        await regenerateCharacterUpdate(sceneId, charUpdate.characterId, guidance);
    });

    $btnRow.find(".rst-regen-toggle").on("click", () => {
        $regenBox.toggleClass("open");
    });

    $btnRow.find(".rst-btn-approve").on("click", async () => {
        await approveCharacterUpdate(charUpdate, sceneId);
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

        const isCritical = Array.isArray(charUpdate.criticalStats) && charUpdate.criticalStats.includes(cat + "." + stat);
        const critBadge = isCritical ? ' <span class="rst-crit-badge"><i class="fa-solid fa-bolt"></i> critical</span>' : '';

        $cat.append(`
            <div class="rst-sr">
                <span class="rst-sn">${stat.charAt(0).toUpperCase() + stat.slice(1)}${critBadge}</span>
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
            if (profile.avatar) { avContent = `<img src="${profile.avatar}" alt="">`; }
            const dyn = profile.dynamicTitle || "No dynamic yet";
            const topStat = (cat) => {
                const stats = profile.stats?.[cat] || {};
                let best = 0;
                for (const k of STAT_NAMES) { const v = stats[k] ?? 0; if (Math.abs(v) > Math.abs(best)) best = v; }
                return best;
            };
            const plat = topStat("platonic"), rom = topStat("romantic"), sex = topStat("sexual");
            const hcls = (v) => Math.abs(v) >= 40 ? "hi" : "";
            const $chip = $(`
                <div class="rst-pcard" style="cursor:pointer">
                    <div class="rst-av">${avContent}</div>
                    <div class="rst-pinfo">
                        <div class="rst-pname">${profile.name}</div>
                        <div class="rst-pdyn">${dyn}</div>
                    </div>
                    <div class="rst-pstat">
                        <div class="rst-pstat-item"><div class="rst-pstat-val ${hcls(plat)}">${plat}%</div><div class="rst-pstat-lbl">Plat</div></div>
                        <div class="rst-pstat-item"><div class="rst-pstat-val ${hcls(rom)}">${rom}%</div><div class="rst-pstat-lbl">Rom</div></div>
                        <div class="rst-pstat-item"><div class="rst-pstat-val ${hcls(sex)}">${sex}%</div><div class="rst-pstat-lbl">Sex</div></div>
                    </div>
                    <span class="rst-present-remove" data-char-id="${charId}" title="Remove from presence"><i class="fa-solid fa-xmark"></i></span>
                </div>
            `);

            // Click on chip opens library tab
            $chip.on("click", () => {
                switchTab("lib");
                $(document).trigger("rst:select-character", [charId]);
            });

            // Click on remove button removes character from presence
            $chip.find(".rst-present-remove").on("click", async (e) => {
                e.stopPropagation();
                const idToRemove = $(e.target).data("char-id");
                const filtered = getPresentCharacters().filter((id) => id !== idToRemove);
                savePresentCharacters(filtered);
                const { updateInjection } = await import("../inject/promptInjector.js");
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
            $addSelect.append(`<option value="${c.id}">${c.name}</option>`);
        }
        $addSelect.val("");
        $addBtn.prop("disabled", true);
    }

    $addSelect.on("change", function () {
        $addBtn.prop("disabled", !$(this).val());
    });

    $addBtn.on("click", async () => {
        const newId = $addSelect.val();
        if (!newId) return;
        const currentIds = getPresentCharacters();
        if (!currentIds.includes(newId)) {
            const updatedIds = [...currentIds, newId];
            savePresentCharacters(updatedIds);
            const { updateInjection } = await import("../inject/promptInjector.js");
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

/**
 * Approve a single character's pending update.
 * @param {object} charUpdate
 */
async function approveCharacterUpdate(charUpdate, sceneId) {
    dlog("[RST] Approving update for:", charUpdate.characterName, { sceneId, statsBefore: charUpdate.statsBefore, statsAfter: charUpdate.statsAfter, commentary: charUpdate.commentary });
    try {
        const { updateCharacterStats, updateCharacterProfile, addUpdateLogEntry } = await import("../data/characters.js");
        const { updateSceneSummary } = await import("../data/scenes.js");

        // Commit stats
        dlog("[RST] Committing stats for:", charUpdate.characterName, charUpdate.statsAfter);
        updateCharacterStats(charUpdate.characterId, charUpdate.statsAfter);

        // Apply any hard-lock caps that a critical raised this scene. The cap
        // rises to the broken-through value so future normal growth can fill up
        // to the new ceiling, and a further critical is needed to climb again.
        const hasRaised = Array.isArray(charUpdate.raisedCaps) && charUpdate.raisedCaps.length > 0;
        const hasProposed = Array.isArray(charUpdate.proposedHardLocks) && charUpdate.proposedHardLocks.length > 0;
        if (hasRaised || hasProposed) {
            const { getCharacterProfile } = await import("../data/characters.js");
            const prof = getCharacterProfile(charUpdate.characterId);
            if (prof && prof.hardLocks) {
                // Critical-raised caps: cap rises to the broken-through value.
                for (const rc of (charUpdate.raisedCaps || [])) {
                    const [cat, stat] = String(rc.stat).split(".");
                    if (prof.hardLocks[cat] && prof.hardLocks[cat][stat]) {
                        prof.hardLocks[cat][stat].cap = rc.to;
                    }
                }
                // Newly proposed locks from the LLM (approved alongside the update).
                // Hard requirement: never apply LLM-proposed locks to a character
                // whose Personality (description) is empty — the model would be
                // guessing on a blank slate. Manual user-set locks are unaffected.
                const personaFilled = !!(prof.description && prof.description.trim());
                for (const pl of (personaFilled ? (charUpdate.proposedHardLocks || []) : [])) {
                    if (!pl || typeof pl.cap !== 'number') continue;
                    const [cat, stat] = String(pl.stat).split(".");
                    if (prof.hardLocks[cat] && prof.hardLocks[cat][stat]) {
                        const cur = prof.hardLocks[cat][stat].cap;
                        // Don't lower an existing higher cap; only set/tighten when sensible.
                        if (cur === null || pl.cap > cur) {
                            prof.hardLocks[cat][stat] = { cap: pl.cap, reason: pl.reason || "" };
                        }
                    }
                }
                updateCharacterProfile(charUpdate.characterId, { hardLocks: prof.hardLocks });
                dlog("[RST] Applied lock changes:", { raised: charUpdate.raisedCaps, proposed: charUpdate.proposedHardLocks });
            }
        }

        // ── Soft lock application ──
        const hasSoftProp = Array.isArray(charUpdate.proposedSoftLocks) && charUpdate.proposedSoftLocks.length > 0;
        const hasUnlocked = Array.isArray(charUpdate.unlockedSoftLocks) && charUpdate.unlockedSoftLocks.length > 0;
        const hasProgress = Array.isArray(charUpdate.softLockProgress) && charUpdate.softLockProgress.length > 0;
        if (hasSoftProp || hasUnlocked || hasProgress) {
            const { getCharacterProfile, updateCharacterProfile } = await import("../data/characters.js");
            const prof = getCharacterProfile(charUpdate.characterId);
            if (prof && prof.softLocks) {
                const personaFilled = !!(prof.description && prof.description.trim());
                const { getSoftLockAvailability } = await import("../data/characters.js");
                const { getClosedSceneCountForChar } = await import("../data/scenes.js");
                const sceneCount = getClosedSceneCountForChar(charUpdate.characterId);

                // 1) Resolve met conditions FIRST (auto-unlock). Stamp setAtScene so
                //    the cooldown clock starts ticking from when the lock resolved.
                for (const key of (charUpdate.unlockedSoftLocks || [])) {
                    const [cat, stat] = String(key).split(".");
                    const sl = prof.softLocks[cat]?.[stat];
                    if (sl && sl.cap !== null && !sl.met) {
                        sl.met = true;
                        sl.setAtScene = sceneCount; // resolution resets the cooldown clock
                    }
                }
                // 2) Progress notes for still-locked soft locks.
                for (const pr of (charUpdate.softLockProgress || [])) {
                    if (!pr || !pr.stat) continue;
                    const [cat, stat] = String(pr.stat).split(".");
                    const sl = prof.softLocks[cat]?.[stat];
                    if (sl && sl.cap !== null && !sl.met) {
                        sl.progress = String(pr.progress || "").slice(0, 400);
                    }
                }
                // 3) New proposed soft locks — gated by personality, the 1-active
                //    cap, and the cooldown. Mechanical enforcement so the LLM can't
                //    flood locks even if it ignores the CLOSED signal in the prompt.
                //    Only the FIRST valid proposal is taken (cap = 1).
                if (personaFilled) {
                    const avail = getSoftLockAvailability(prof, sceneCount);
                    if (avail.allowed) {
                        for (const sl of (charUpdate.proposedSoftLocks || [])) {
                            if (!sl || typeof sl.cap !== 'number') continue;
                            const [cat, stat] = String(sl.stat).split(".");
                            const slot = prof.softLocks[cat]?.[stat];
                            if (!slot) continue;
                            // Only fill an empty/resolved slot, and require a condition.
                            if ((slot.cap === null || slot.met) && sl.condition && String(sl.condition).trim()) {
                                prof.softLocks[cat][stat] = {
                                    cap: sl.cap,
                                    condition: String(sl.condition).slice(0, 300),
                                    progress: (sl.progress || "").toString().slice(0, 400),
                                    met: false,
                                    setAtScene: sceneCount,
                                };
                                break; // cap of 1 active — take only the first valid proposal
                            }
                        }
                    } else {
                        dlog("[RST] Soft lock proposal suppressed:", avail.reason);
                    }
                }
                updateCharacterProfile(charUpdate.characterId, { softLocks: prof.softLocks });
                dlog("[RST] Applied soft-lock changes:", { proposed: charUpdate.proposedSoftLocks, unlocked: charUpdate.unlockedSoftLocks });
            }
        }

        // Update dynamic title and narrative
        updateCharacterProfile(charUpdate.characterId, {
            dynamicTitle: charUpdate.dynamicTitleAfter,
            narrativeSummary: charUpdate.narrativeSummary,
        });

        // Get actual message range from the scene
        const scene = sceneId ? getSceneById(sceneId) : null;
        const messageRange = scene
            ? { start: scene.messageStart, end: scene.messageEnd }
            : null; // No scene available — skip message range in log entry

        // Create update log entry
        dlog("[RST] Adding update log entry for:", charUpdate.characterName, { statsBefore: charUpdate.statsBefore, statsAfter: charUpdate.statsAfter, commentary: charUpdate.commentary });
        addUpdateLogEntry(charUpdate.characterId, {
            sceneId: sceneId || "",
            messageRange,
            timestamp: Date.now(),
            statsBefore: charUpdate.statsBefore,
            statsAfter: charUpdate.statsAfter,
            commentary: charUpdate.commentary,
            dynamicTitleBefore: charUpdate.dynamicTitleBefore,
            dynamicTitleAfter: charUpdate.dynamicTitleAfter,
            narrativeSummary: charUpdate.narrativeSummary,
            criticalStats: charUpdate.criticalStats || [],
            source: charUpdate.source || "unknown",
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
        dlog("[RST] Removed from pending:", charUpdate.characterName);

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

    // Save the scene summary first (if present)
    if (pending.sceneId && pending.sceneSummary) {
        try {
            const { updateSceneSummary } = await import("../data/scenes.js");
            updateSceneSummary(pending.sceneId, pending.sceneSummary);
        } catch (err) {
            console.error("[RST] Failed to save scene summary during approve-all:", err);
        }
    }

    for (const charUpdate of pending.characterUpdates) {
        await approveCharacterUpdate(charUpdate, pending.sceneId);
    }

    toastr?.success?.("All stat changes approved and saved.");
}

/**
 * Dismiss all pending updates.
 */
function dismissAllPending() {
    const pending = getPendingUpdates();

    // Delete any auto-created character profiles (tracked deterministically during generation)
    if (pending && pending.autoCreatedIds && pending.autoCreatedIds.length > 0) {
        for (const id of pending.autoCreatedIds) {
            deleteCharacterData(id);
        }
    }

    // If there's a scene associated with these pending updates, delete it
    if (pending && pending.sceneId) {
        deleteScene(pending.sceneId);
    }

    savePendingUpdates(null);
    toastr?.info?.("All pending stat changes dismissed. Scene removed.");

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

    if (pending.characterUpdates.length === 0) {
        savePendingUpdates(null);
    } else {
        savePendingUpdates(pending);
    }

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
    showPanelLoading("Regenerating scene summary...");
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
    showPanelLoading("Regenerating stat updates...");
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
            <input type="text" id="rst-edit-name" value="${currentName.replace(/"/g, '"')}"
                style="width:100%;padding:5px 8px;font-size:12px;border:0.5px solid var(--rst-border);border-radius:6px;background:var(--rst-bg);color:var(--rst-text)">
        </div>

        <div style="margin-bottom:8px">
            <div style="font-size:11px;color:var(--rst-text-muted);margin-bottom:3px">
                <span>Description</span>
                <i class="editor_maximize fa-solid fa-maximize right_menu_button" data-for="rst-edit-description" title="Expand the editor"></i>
            </div>
            <textarea id="rst-edit-description" rows="2"
                style="width:100%;padding:5px 8px;font-size:12px;border:0.5px solid var(--rst-border);border-radius:6px;background:var(--rst-bg);color:var(--rst-text);resize:vertical">${currentDesc.replace(/"/g, '"')}</textarea>
        </div>

        <div style="margin-bottom:8px">
            <div style="font-size:11px;color:var(--rst-text-muted);margin-bottom:3px">
                <span>Notes</span>
                <i class="editor_maximize fa-solid fa-maximize right_menu_button" data-for="rst-edit-notes" title="Expand the editor"></i>
            </div>
            <textarea id="rst-edit-notes" rows="2"
                style="width:100%;padding:5px 8px;font-size:12px;border:0.5px solid var(--rst-border);border-radius:6px;background:var(--rst-bg);color:var(--rst-text);resize:vertical">${currentNotes.replace(/"/g, '"')}</textarea>
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
                        value="${commentText}"
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
        <input type="text" id="rst-edit-title" value="${editedTitle}"
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
            style="width:100%;padding:5px 8px;font-size:12px;border:0.5px solid var(--rst-border);border-radius:6px;background:var(--rst-bg);color:var(--rst-text);resize:vertical">${editedNarrative}</textarea>
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
                        dlog("[RST] Save changes clicked for:", charUpdate.characterName);
                        // Read all edited values from the DOM while it's still present
                        const newStats = JSON.parse(JSON.stringify(charUpdate.statsAfter || {}));
                        $(popup.dlg).find(".rst-edit-stat").each(function () {
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
                        // Reset profile fields
                        $(popup.dlg).find("#rst-edit-name").val(profile.name || charUpdate.characterName || "");
                        $(popup.dlg).find("#rst-edit-description").val(profile.description || "");
                        $(popup.dlg).find("#rst-edit-notes").val(profile.notes || "");
                        // Reset stat fields
                        const originalAfter = charUpdate.statsAfter || {};
                        $(popup.dlg).find(".rst-edit-stat").each(function () {
                            const cat = $(this).data("cat");
                            const stat = $(this).data("stat");
                            $(this).val(originalAfter[cat]?.[stat] ?? 0);
                        });
                        // Reset dynamic fields
                        $(popup.dlg).find("#rst-edit-title").val(charUpdate.dynamicTitleAfter || "");
                        $(popup.dlg).find("#rst-edit-narrative").val(charUpdate.narrativeSummary || "");
                        $(popup.dlg).find(".rst-edit-commentary").each(function () {
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
        await popup.show();
    } catch (err) {
        console.error("[RST] Failed to open edit modal:", err);

        // Fallback: use ST Popup with custom button for JSON editing
        try {
            const fallbackHtml = `
                <h3>Edit stats for ${charUpdate.characterName}</h3>
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
            await fallbackPopup.show();
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
