import { captureChatScope } from "../lib/chatScope.js";
/**
 * settings.js — Settings tab: all config UI
 * Renders the Settings tab with accordion-collapsed sections (NWST-style)
 * Connection Profiles are NOT accordion-wrapped to ensure ConnectionManager initializes properly
 */

import { getSettings, saveSetting, persistSettings, getNameBlacklist, saveNameBlacklist, parseNameBlacklist, addNamesToBlacklist, getPendingLockScan, savePendingLockScan, getPendingMilestoneScan, savePendingMilestoneScan, getPendingConditionScan, savePendingConditionScan } from "../data/storage.js";
import { setSetting, isEnabled, exportAllData, importAllData } from "../settings.js";
import { ConnectionManagerRequestService } from "../../../../extensions/shared.js";
import { getContext } from "../../../../extensions.js";
import { Popup, POPUP_TYPE, POPUP_RESULT } from "../../../../../scripts/popup.js";
import { scanForLocks } from "../llm/lockScan.js";
import { scanHistoricalMilestones } from "../llm/milestoneScan.js";
import { getAllCharacters, findCharacterByName, findCharacterByFuzzyName, resolveCharacterIdentity } from "../data/characters.js";
import { getRelationshipConditionDefinition } from "../data/conditions.js";
import { scanHistoricalConditions } from "../llm/conditionBackfill.js";
import { scanMissedCharacters } from "../llm/sidecar.js";
import { showNewCharacterDetected } from "./library.js";
import { getPane } from "./panel.js";


function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// SillyTavern's connection-dropdown helper registers three permanent
// host event listeners every time it is called.  RST rebuilds its Settings tab
// on tab entry and chat changes, so using that helper here accumulated detached
// dropdowns and duplicate callbacks for the rest of the page session.  Keep one
// host refresh listener set, and render each current dropdown from a snapshot.
const connectionEventSources = new WeakSet();

function supportedConnectionProfiles() {
    const context = getContext?.();
    if (context?.extensionSettings?.disabledExtensions?.includes("connection-manager")) return [];
    const profiles = Array.isArray(context?.extensionSettings?.connectionManager?.profiles)
        ? context.extensionSettings.connectionManager.profiles
        : [];
    return profiles
        .filter((profile) => {
            try {
                return typeof ConnectionManagerRequestService.isProfileSupported !== "function"
                    || ConnectionManagerRequestService.isProfileSupported(profile);
            } catch {
                return false;
            }
        })
        .slice()
        .sort((a, b) => String(a?.name || "").localeCompare(String(b?.name || "")));
}

function bindConnectionDropdown($dropdown, selectedId, onChange) {
    $dropdown.empty();
    $dropdown.append('<option value="">Select a Connection Profile</option>');
    const profiles = supportedConnectionProfiles();
    for (const profile of profiles) {
        const id = String(profile?.id || "");
        if (!id) continue;
        $dropdown.append(`<option value="${escapeHtml(id)}">${escapeHtml(profile?.name || "Unnamed")}</option>`);
    }
    const selectedProfile = profiles.find((profile) =>
        String(profile?.id || "") === String(selectedId || "")
        || String(profile?.name || "") === String(selectedId || ""));
    const selected = String(selectedProfile?.id || "");
    $dropdown.val(selected);
    $dropdown.off("change.rst-connection").on("change.rst-connection", function () {
        const id = String($(this).val() || "");
        const profile = profiles.find((candidate) => String(candidate?.id || "") === id) || null;
        onChange(profile);
    });
}

function ensureConnectionProfileRefresh() {
    const context = getContext?.();
    const source = context?.eventSource;
    if (!source || typeof source.on !== "function" || connectionEventSources.has(source)) return;
    connectionEventSources.add(source);
    const rerender = () => {
        const $pane = getPane("settings");
        if ($pane?.length) renderSettingsTab($pane);
    };
    for (const key of ["CONNECTION_PROFILE_CREATED", "CONNECTION_PROFILE_UPDATED", "CONNECTION_PROFILE_DELETED"]) {
        const eventName = context?.eventTypes?.[key];
        if (eventName) source.on(eventName, rerender);
    }
}

// ─── Explicit Section Saving ──────────────────────────────

function appendSectionSaveButton($container, id, label) {
    const $row = $(`
        <div class="rst-setting-row rst-explicit-save-row" style="border-bottom:none;justify-content:flex-end">
            <button id="${id}" class="rst-btn rst-explicit-save-btn" type="button">
                <i class="fa-solid fa-floppy-disk"></i> ${label}
            </button>
        </div>
    `);
    $container.append($row);
    return $row.find(`#${id}`);
}

async function commitSectionNow($button, label, commitFn) {
    if (!$button?.length) return false;
    const originalHtml = $button.html();
    $button.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> Saving...');

    try {
        await Promise.resolve(commitFn?.());
        const saved = await persistSettings();
        if (saved === false) throw new Error("Immediate settings persistence failed.");
        $button.html('<i class="fa-solid fa-check"></i> Saved');
        toastr?.success?.(`${label} saved.`, "Relationship Stat Tracker");
        setTimeout(() => {
            if ($button?.length) $button.html(originalHtml);
        }, 1200);
        return true;
    } catch (err) {
        console.error(`[RST] Failed to save ${label}.`, err);
        $button.html('<i class="fa-solid fa-triangle-exclamation"></i> Save failed');
        toastr?.error?.(`${label} could not be saved. Check the console/server connection.`, "Relationship Stat Tracker");
        setTimeout(() => {
            if ($button?.length) $button.html(originalHtml);
        }, 1800);
        return false;
    } finally {
        $button.prop("disabled", false);
    }
}

// ─── Accordion Helper ─────────────────────────────────────

/**
 * Create an accordion section — collapsed by default.
 * @param {jQuery} $pane
 * @param {string} label - Section header text
 * @param {function(jQuery):void} renderFn - Called with the body container
 */
function renderAccordion($pane, label, renderFn) {
    const id = "rst-accordion-" + label.toLowerCase().replace(/\s+/g, "-");
    const $section = $(`
        <div class="rst-accordion" id="${id}">
            <div class="rst-accordion-hdr">
                <span class="rst-accordion-label">${label}</span>
                <i class="fa-solid fa-chevron-down rst-accordion-chevron"></i>
            </div>
            <div class="rst-accordion-body" style="display:none"></div>
        </div>
    `);

    const $body = $section.find(".rst-accordion-body");
    renderFn($body);

    $section.find(".rst-accordion-hdr").on("click", function () {
        const $body = $(this).next(".rst-accordion-body");
        $body.slideToggle(200);
        $(this).find(".rst-accordion-chevron").toggleClass("open");
    });

    $pane.append($section);
}

// ─── Main Render ──────────────────────────────────────────

export function renderSettingsTab($pane) {
    $pane.empty();
    const settings = getSettings();

    // Connection Profiles — rendered OUTSIDE accordion so ConnectionManager can initialize
    $pane.append('<div class="rst-lbl">Connection Profiles</div>');
    const $connCard = $('<div class="rst-card"></div>');
    $pane.append($connCard);
    renderConnectionProfiles($connCard, settings);

    renderAccordion($pane, "Batch Scan", ($body) => {
        renderBatchScan($body, settings);
    });

    renderAccordion($pane, "Scene Summary Prompt", ($body) => {
        renderSceneSummaryPrompt($body, settings);
    });

    renderAccordion($pane, "Stat Settings", ($body) => {
        renderStatSettings($body, settings);
    });

    renderAccordion($pane, "Detection Settings", ($body) => {
        renderDetectionSettings($body, settings);
    });

    renderAccordion($pane, "Injection Settings", ($body) => {
        renderInjectionSettings($body, settings);
    });

    renderAccordion($pane, "Data", ($body) => {
        renderDataSection($body);
    });

    renderAccordion($pane, "Debug", ($body) => {
        renderDebugSettings($body, settings);
    });
}

// ─── Debug Settings ───────────────────────────────────────

function renderDebugSettings($pane, settings) {
    const $card = $('<div class="rst-card"></div>');
    $card.append(`
        <div class="rst-setting-row">
            <div>
                <div class="rst-setting-label">Debug F12 logging</div>
                <div class="rst-setting-sub">Show RST activity logs in the browser console · warnings and errors always show</div>
            </div>
            <label class="rst-toggle"><input type="checkbox" id="rst-debug-toggle" ${settings.debug ? "checked" : ""}><span class="rst-slider"></span></label>
        </div>
        <div class="rst-setting-row">
            <div>
                <div class="rst-setting-label">Backfill Relationship Milestones</div>
                <div class="rst-setting-sub">Retroactively read the full visible chat in Batch-Scan-compatible chunks and propose durable relationship turning points for existing character profiles. Read-only history only; stats are never changed. Every proposal is reviewed before commit.</div>
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0">
                <button id="rst-review-milestones-btn" class="rst-btn" style="display:${getPendingMilestoneScan() ? 'inline-flex' : 'none'}"><i class="fa-solid fa-list-check"></i> Review</button>
                <button id="rst-scan-milestones-btn" class="rst-btn"><i class="fa-solid fa-flag"></i> Backfill</button>
            </div>
        </div>
        <div class="rst-setting-row">
            <div>
                <div class="rst-setting-label">Backfill Temporary Statuses</div>
                <div class="rst-setting-sub">Chronologically reconstruct status activation, development, and resolution across the full visible chat. Only end-of-chat statuses are proposed; review is required before current data changes.</div>
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0">
                <button id="rst-preview-conditions-btn" class="rst-btn"><i class="fa-solid fa-eye"></i> Current</button>
                <button id="rst-review-conditions-btn" class="rst-btn" style="display:${getPendingConditionScan() ? 'inline-flex' : 'none'}"><i class="fa-solid fa-list-check"></i> Review</button>
                <button id="rst-scan-conditions-btn" class="rst-btn"><i class="fa-solid fa-tags"></i> Backfill</button>
            </div>
        </div>
        <div class="rst-setting-row">
            <div>
                <div class="rst-setting-label">Scan for Missed Characters</div>
                <div class="rst-setting-sub">Debug catch-up pass for NPCs that may have appeared before the live sidecar checkpoint. Scans recent narrative messages in small chronological chunks and only proposes unknown active names. It does not change current presence or sidecar cadence.</div>
            </div>
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end;flex-shrink:0">
                <label style="font-size:11px;color:var(--rst-text-muted)">Recent
                    <select id="rst-missed-char-window" style="width:58px;margin-left:3px">
                        ${[20, 30, 50, 100].map((n) => `<option value="${n}"${n === (settings.debugMissedCharacterScan?.messageCount || 30) ? " selected" : ""}>${n}</option>`).join("")}
                    </select>
                </label>
                <label style="font-size:11px;color:var(--rst-text-muted)">Chunk
                    <select id="rst-missed-char-chunk" style="width:52px;margin-left:3px">
                        ${[3, 5, 7, 10].map((n) => `<option value="${n}"${n === (settings.debugMissedCharacterScan?.chunkSize || 5) ? " selected" : ""}>${n}</option>`).join("")}
                    </select>
                </label>
                <button id="rst-scan-missed-chars-btn" class="rst-btn"><i class="fa-solid fa-user-plus"></i> Scan</button>
            </div>
        </div>
        <div class="rst-setting-row" style="border-bottom:none">
            <div>
                <div class="rst-setting-label">Scan for Threshold Locks</div>
                <div class="rst-setting-sub">Read the full visible chat in chunks, then combine that history with Personality, Notes, current stats, trajectory, milestones, conditions, summaries, and existing locks. Existing lock slots are preserved; this pass only proposes missing locks. You review everything before apply.</div>
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0">
                <button id="rst-review-scan-btn" class="rst-btn" style="display:${getPendingLockScan() ? 'inline-flex' : 'none'}"><i class="fa-solid fa-list-check"></i> Review</button>
                <button id="rst-scan-locks-btn" class="rst-btn"><i class="fa-solid fa-lock"></i> Scan</button>
            </div>
        </div>
    `);
    $pane.append($card);

    $card.find("#rst-debug-toggle").on("change", function () {
        const on = $(this).prop("checked");
        saveSetting("debug", on);
        toastr?.info?.(`Debug logging ${on ? "enabled" : "disabled"}.`, "Relationship Stat Tracker");
    });

    $card.find("#rst-missed-char-window").on("change", function () {
        saveSetting("debugMissedCharacterScan.messageCount", parseInt($(this).val(), 10) || 30);
    });
    $card.find("#rst-missed-char-chunk").on("change", function () {
        saveSetting("debugMissedCharacterScan.chunkSize", parseInt($(this).val(), 10) || 5);
    });

    $card.find("#rst-scan-missed-chars-btn").on("click", async function () {
        const rstScopeMissed = captureChatScope();
        const $btn = $(this);
        const messageCount = parseInt($card.find("#rst-missed-char-window").val(), 10) || 30;
        const chunkSize = parseInt($card.find("#rst-missed-char-chunk").val(), 10) || 5;
        saveSetting("debugMissedCharacterScan.messageCount", messageCount);
        saveSetting("debugMissedCharacterScan.chunkSize", chunkSize);

        $btn.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> Scanning...');
        try {
            const result = await rstScopeMissed.wait(() => scanMissedCharacters({
                messageCount,
                chunkSize,
                shouldContinue: () => rstScopeMissed.isCurrent(),
                onProgress: (current, total) => {
                    if (!rstScopeMissed.isCurrent()) return;
                    $btn.html(`<i class="fa-solid fa-spinner fa-spin"></i> ${current}/${total}`);
                },
            }));

            if (!rstScopeMissed.isCurrent() || result.cancelled) return;

            const candidates = Array.isArray(result.candidates) ? result.candidates : [];
            if (!candidates.length) {
                const suffix = result.failedChunks
                    ? ` ${result.failedChunks} chunk${result.failedChunks === 1 ? "" : "s"} could not be validated; rerun if needed.`
                    : "";
                toastr?.info?.(`Missed-character scan found no unknown active NPCs in the last ${result.scannedMessages} narrative messages.${suffix}`, "Relationship Stat Tracker");
                return;
            }

            let createdCount = 0;
            let ignoredCount = 0;
            let dismissedCount = 0;
            for (const candidate of candidates) {
                if (!rstScopeMissed.isCurrent()) return;
                const name = String(candidate?.name || "").trim();
                if (!name) continue;

                // A previous popup in this pass may already have created an alias-equivalent profile.
                // Ambiguous known identities also fail closed instead of offering
                // another automatic profile.
                const identity = resolveCharacterIdentity(name);
                if (identity.status === "match" || identity.status === "ambiguous") continue;

                const decision = await showNewCharacterDetected(
                    name,
                    () => rstScopeMissed.isCurrent(),
                    { historical: true },
                );
                if (!rstScopeMissed.isCurrent()) return;

                if (decision === true) {
                    createdCount++;
                } else if (decision === false) {
                    ignoredCount++;
                    const persisted = await Promise.resolve(addNamesToBlacklist(name, true));
                    if (persisted === false) {
                        toastr?.warning?.(`Ignored ${name}, but its blacklist entry could not be confirmed on disk.`);
                    }
                } else {
                    dismissedCount++;
                }
            }

            const failedNote = result.failedChunks
                ? ` ${result.failedChunks}/${result.totalChunks} chunks failed validation.`
                : "";
            toastr?.success?.(
                `Catch-up scan complete: ${createdCount} created, ${ignoredCount} ignored, ${dismissedCount} dismissed.${failedNote}`,
                "Relationship Stat Tracker",
            );
        } catch (err) {
            if (err?.code === "RST_STALE_CHAT") return;
            console.error("[RST] Missed-character catch-up scan failed:", err);
            toastr?.error?.(err?.message || "Missed-character catch-up scan failed. Check the console and sidecar connection.", "Relationship Stat Tracker");
        } finally {
            $btn.prop("disabled", false).html('<i class="fa-solid fa-user-plus"></i> Scan');
        }
    });

    $card.find("#rst-preview-conditions-btn").on("click", async function () {
    const rstScope1 = captureChatScope();

        const rows = [];
        for (const character of getAllCharacters()) {
            const conditions = Array.isArray(character.relationshipConditions) ? character.relationshipConditions : [];
            if (!conditions.length) continue;
            rows.push(`<h3>${escapeHtml(character.name || "Unnamed character")}</h3>`);
            for (const condition of conditions) {
                const def = getRelationshipConditionDefinition(condition?.type);
                rows.push(`<div class="rst-pending-system-item">
                    <div class="rst-pending-system-name">${escapeHtml(def?.label || condition?.type || "Unknown status")}</div>
                    <div><b>Active because:</b> ${escapeHtml(condition?.reason || def?.meaning || "(no reason stored)")}</div>
                    <div><b>Resolves when:</b> ${escapeHtml(condition?.resolution || "(no resolution rule stored)")}</div>
                    <div><b>Internal stat-update effect:</b> ${escapeHtml(def?.effect || "(unknown status type)")}</div>
                </div>`);
            }
        }
        const html = rows.length
            ? `<div class="rst-condition-debug-preview">${rows.join("")}</div>`
            : '<div class="rst-empty">No active temporary relationship statuses exist in this chat.</div>';
        const popup = new Popup(html, POPUP_TYPE.TEXT, "", { wide: true, allowVerticalScrolling: true });
        await rstScope1.wait(() => (popup.show()));
    });

    $card.find("#rst-review-conditions-btn").on("click", async function () {
    const rstScope2 = captureChatScope();

        const pending = getPendingConditionScan();
        if (!pending) return toastr?.info?.("No pending temporary-status backfill to review.");
        await rstScope2.wait(() => (reviewConditionScanResults(pending)));
    });

    $card.find("#rst-scan-conditions-btn").on("click", async function () {
    const rstScope3 = captureChatScope();

        const $btn = $(this);
        $btn.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> Scanning...');
        try {
            const results = await rstScope3.wait(() => (scanHistoricalConditions((current, total) => {
    if (!rstScope3.isCurrent()) return;

                $btn.html(`<i class="fa-solid fa-spinner fa-spin"></i> ${current}/${total}`);
            })));
            if (!results.length) return toastr?.info?.("No character history was available to scan.");
            savePendingConditionScan(results);
            $card.find("#rst-review-conditions-btn").show();
            await rstScope3.wait(() => (reviewConditionScanResults(results)));
        } catch (err) {
            console.error("[RST] Temporary-status backfill failed:", err);
            toastr?.error?.("Temporary-status backfill stopped without applying partial results. Check the console and connection.");
        } finally {
            $btn.prop("disabled", false).html('<i class="fa-solid fa-tags"></i> Backfill');
        }
    });

    $card.find("#rst-review-milestones-btn").on("click", async function () {
    const rstScope4 = captureChatScope();

        const pending = getPendingMilestoneScan();
        if (!pending || pending.length === 0) {
            toastr?.info?.("No pending milestone backfill to review.");
            $card.find("#rst-review-milestones-btn").hide();
            return;
        }
        await rstScope4.wait(() => (reviewMilestoneScanResults(pending)));
    });

    $card.find("#rst-scan-milestones-btn").on("click", async function () {
    const rstScope5 = captureChatScope();

        const $btn = $(this);
        $btn.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> Scanning...');
        try {
            const results = await rstScope5.wait(() => (scanHistoricalMilestones()));
            if (!results || results.length === 0) {
                toastr?.info?.("Milestone backfill complete — no durable milestones were proposed.", "Relationship Stat Tracker");
                return;
            }
            savePendingMilestoneScan(results);
            $card.find("#rst-review-milestones-btn").show();
            await rstScope5.wait(() => (reviewMilestoneScanResults(results)));
        } catch (err) {
            console.error("[RST] Milestone backfill error:", err);
            toastr?.error?.("Milestone backfill failed. Check the console and connection settings.");
        } finally {
            $btn.prop("disabled", false).html('<i class="fa-solid fa-flag"></i> Backfill');
        }
    });

    $card.find("#rst-review-scan-btn").on("click", async function () {
    const rstScope6 = captureChatScope();

        const pending = getPendingLockScan();
        if (!pending || pending.length === 0) {
            toastr?.info?.("No pending lock scan to review.");
            $card.find("#rst-review-scan-btn").hide();
            return;
        }
        await rstScope6.wait(() => (reviewLockScanResults(pending)));
    });

    $card.find("#rst-scan-locks-btn").on("click", async function () {
    const rstScope7 = captureChatScope();

        const $btn = $(this);
        $btn.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> Scanning...');
        try {
            const results = await rstScope7.wait(() => (scanForLocks()));
            if (!results || results.length === 0) {
                toastr?.info?.("Scan complete — no new locks proposed.", "Relationship Stat Tracker");
                return;
            }
            savePendingLockScan(results);
            $card.find("#rst-review-scan-btn").show();
            await rstScope7.wait(() => (reviewLockScanResults(results)));
        } catch (err) {
            console.error("[RST] Lock scan error:", err);
            toastr?.error?.("Lock scan failed. Check the console and your connection settings.");
        } finally {
            $btn.prop("disabled", false).html('<i class="fa-solid fa-lock"></i> Scan');
        }
    });
}

// ─── Temporary-status backfill review (reopenable) ───────

async function reviewConditionScanResults(results) {
    const rstScope8 = captureChatScope();

    const blocks = [];
    for (const r of results) {
        const currentCount = Array.isArray(r.previousConditions) ? r.previousConditions.length : 0;
        const final = Array.isArray(r.finalConditions) ? r.finalConditions : [];
        const trail = Array.isArray(r.transitions) ? r.transitions : [];
        if (!currentCount && !final.length && !trail.length) continue;
        const finalRows = final.length ? final.map((condition) => {
    if (!rstScope8.isCurrent()) return;

            const def = getRelationshipConditionDefinition(condition.type);
            return `<div class="rst-milestone-scan-content"><div><span class="rst-scan-tag soft">ACTIVE</span> <b>${escapeHtml(def?.label || condition.type)}</b></div>
                <div class="rst-scan-why">${escapeHtml(condition.reason)}</div>
                <div class="rst-scan-why"><b>Resolves when:</b> ${escapeHtml(condition.resolution)}</div></div>`;
        }).join("") : '<div class="rst-scan-why"><b>Final state:</b> No active temporary statuses.</div>';
        const trailRows = trail.length ? trail.map((t) => {
    if (!rstScope8.isCurrent()) return;

            const def = getRelationshipConditionDefinition(t.type);
            return `<li><b>${escapeHtml(String(t.op || "").toUpperCase())} ${escapeHtml(def?.label || t.type)}</b> · messages ${escapeHtml(t.messageRange?.start)}–${escapeHtml(t.messageRange?.end)}${t.reason ? ` — ${escapeHtml(t.reason)}` : ""}</li>`;
        }).join("") : "<li>No transitions detected.</li>";
        blocks.push(`<label class="rst-milestone-scan-row">
            <input type="checkbox" class="rst-condition-scan-pick" data-charid="${escapeHtml(r.characterId)}" checked>
            <div class="rst-milestone-scan-content" style="width:100%"><div class="rst-scan-stat">${escapeHtml(r.characterName)}</div>
                <div class="rst-scan-why">Stored now: ${currentCount} · Reconstructed final: ${final.length}</div>${finalRows}
                <details><summary>Chronological transition trail (${trail.length})</summary><ol>${trailRows}</ol></details>
            </div></label>`);
    }
    const html = `<div class="rst-scan-review"><div class="rst-scan-summary">Apply replaces each selected character's current temporary statuses with the reconstructed end-of-chat state. Untick any character you do not want changed. Closing keeps this review.</div>
        ${blocks.join("") || '<div class="rst-empty">No status changes were reconstructed.</div>'}
        <label class="rst-scan-discard"><input type="checkbox" id="rst-condition-discard-chk"> Discard this status scan instead of keeping it</label></div>`;
    const popup = new Popup(html, POPUP_TYPE.CONFIRM, "", { okButton: "Apply selected", cancelButton: "Close" });
    const showPromise = popup.show();
    const $dlg = $(popup.dlg);
    const result = await rstScope8.wait(() => (showPromise));
    const discard = !!$dlg.find("#rst-condition-discard-chk")[0]?.checked;
    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        if (discard) {
            savePendingConditionScan(null);
            $("#rst-review-conditions-btn").hide();
            toastr?.info?.("Temporary-status scan discarded.");
        } else toastr?.info?.("Temporary-status scan kept for later review.");
        return;
    }
    const selected = new Set();
    $dlg.find(".rst-condition-scan-pick:checked").each(function () {
    if (!rstScope8.isCurrent()) return;
 if (this.dataset.charid) selected.add(this.dataset.charid); });
    const { getCharacterProfile, updateCharacterProfile } = await rstScope8.wait(() => (import("../data/characters.js")));
    for (const r of results) {
        if (!selected.has(r.characterId)) continue;
        const current = getCharacterProfile(r.characterId);
        if (!current || JSON.stringify(current.relationshipConditions || []) !== JSON.stringify(r.previousConditions || [])) {
            toastr?.warning?.("Statuses changed since this backfill began. Run a fresh backfill before replacing them.");
            return;
        }
    }
    const now = Date.now();
    let applied = 0;
    for (const r of results) {
        if (!selected.has(r.characterId) || !getCharacterProfile(r.characterId)) continue;
        const conditions = (r.finalConditions || []).map((condition, index) => ({
            ...condition,
            id: `condition_backfill_${condition.type}_${now}_${index}`,
            startedAt: now,
            source: "condition_backfill",
        }));
        updateCharacterProfile(r.characterId, { relationshipConditions: conditions });
        applied++;
    }
    savePendingConditionScan(null);
    $("#rst-review-conditions-btn").hide();
    const { updateInjection } = await rstScope8.wait(() => (import("../inject/promptInjector.js")));
    updateInjection();
    toastr?.success?.(`Applied reconstructed temporary-status state to ${applied} character${applied === 1 ? "" : "s"}.`);
}

// ─── Milestone-backfill review (reopenable) ───────────────

async function reviewMilestoneScanResults(results) {
    const rstScope9 = captureChatScope();

    const blocks = [];
    let total = 0;
    for (const r of results) {
        const rows = (r.milestones || []).map((m, index) => {
    if (!rstScope9.isCurrent()) return;

            total++;
            const domains = Array.isArray(m.domains) && m.domains.length
                ? `<span class="rst-scan-cap">${escapeHtml(m.domains.join(" / "))}</span>`
                : "";
            return `<label class="rst-milestone-scan-row">
                <input type="checkbox" class="rst-milestone-scan-pick" data-charid="${escapeHtml(r.characterId)}" data-index="${index}" checked>
                <div class="rst-milestone-scan-content">
                    <div><span class="rst-scan-tag soft">MILESTONE</span> <span class="rst-scan-stat">${escapeHtml(m.title || "Milestone")}</span> ${domains}</div>
                    <div class="rst-scan-why">${escapeHtml(m.description || "")}</div>
                </div>
            </label>`;
        }).join("");
        if (!rows) continue;
        blocks.push(`<details class="rst-scan-char" open>
            <summary><span class="rst-scan-name">${escapeHtml(r.characterName)}</span><span class="rst-scan-count">${r.milestones.length}</span></summary>
            <div class="rst-scan-locks">${rows}</div>
        </details>`);
    }

    const html = `<div class="rst-scan-review">
        <div class="rst-scan-summary">Proposed <b>${total}</b> retroactive relationship milestone${total === 1 ? "" : "s"}. Untick anything that should not become permanent read-only history. Closing keeps this scan for later review.</div>
        ${blocks.join("")}
        <label class="rst-scan-discard"><input type="checkbox" id="rst-milestone-discard-chk"> Discard this milestone scan instead of keeping it</label>
    </div>`;
    const popup = new Popup(html, POPUP_TYPE.CONFIRM, "", { okButton: "Apply selected", cancelButton: "Close" });
    const showPromise = popup.show();
    const $dlg = $(popup.dlg);
    const result = await rstScope9.wait(() => (showPromise));
    const proceed = result === POPUP_RESULT.AFFIRMATIVE;
    const discardChecked = !!($dlg.find("#rst-milestone-discard-chk")[0]?.checked);

    if (!proceed) {
        if (discardChecked) {
            savePendingMilestoneScan(null);
            $("#rst-review-milestones-btn").hide();
            toastr?.info?.("Milestone scan discarded.");
        } else {
            toastr?.info?.("Milestone scan kept — reopen it any time with Review.");
        }
        return;
    }

    const selected = new Map();
    $dlg.find(".rst-milestone-scan-pick").each(function () {
    if (!rstScope9.isCurrent()) return;

        if (!this.checked) return;
        const charId = this.dataset.charid;
        const index = Number(this.dataset.index);
        if (!charId || !Number.isInteger(index)) return;
        if (!selected.has(charId)) selected.set(charId, new Set());
        selected.get(charId).add(index);
    });

    const { getCharacterProfile, updateCharacterProfile } = await rstScope9.wait(() => (import("../data/characters.js")));
    let applied = 0;
    const now = Date.now();
    for (const r of results) {
        const picks = selected.get(r.characterId);
        if (!picks?.size) continue;
        const profile = getCharacterProfile(r.characterId);
        if (!profile) continue;
        const milestones = Array.isArray(profile.relationshipMilestones) ? [...profile.relationshipMilestones] : [];
        const existingTitles = new Set(milestones.map((m) => String(m?.title || "").toLowerCase().trim()));

        for (const index of [...picks].sort((a, b) => a - b)) {
            const m = r.milestones?.[index];
            if (!m) continue;
            const titleKey = String(m.title || "").toLowerCase().trim();
            if (!titleKey || existingTitles.has(titleKey)) continue;
            milestones.push({
                id: `milestone_backfill_${now}_${r.characterId}_${index}`,
                title: String(m.title || "Milestone").slice(0, 160),
                description: String(m.description || "").slice(0, 1200),
                domains: Array.isArray(m.domains) ? [...m.domains] : [],
                timestamp: now,
                source: "milestone_backfill",
            });
            existingTitles.add(titleKey);
            applied++;
        }
        updateCharacterProfile(r.characterId, { relationshipMilestones: milestones });
    }

    savePendingMilestoneScan(null);
    $("#rst-review-milestones-btn").hide();
    toastr?.success?.(`Applied ${applied} retroactive milestone${applied === 1 ? "" : "s"}.`, "Relationship Stat Tracker");

    const { renderLibraryTab } = await rstScope9.wait(() => (import("./library.js")));
    const { getPane } = await rstScope9.wait(() => (import("./panel.js")));
    renderLibraryTab(getPane("lib"));
}

// ─── Lock-scan review (reopenable) ────────────────────────

/**
 * Render the lock-scan review dialog and apply the user's selection.
 * Results are passed in (and are already persisted via savePendingLockScan),
 * so dismissing the dialog with Esc/Cancel keeps them for re-review instead of
 * wasting the scan. Pending results are cleared only when the user applies them
 * or explicitly discards.
 * @param {Array} results
 */
async function reviewLockScanResults(results) {
    const rstScope10 = captureChatScope();

    let totalHard = 0, totalSoft = 0;
    const charBlocks = [];
    for (const r of results) {
        const hardRows = (r.hardLocks || []).map((l) => {
    if (!rstScope10.isCurrent()) return;

            totalHard++;
            const reason = escapeHtml(l.reason || "");
            return `<div class="rst-scan-lock">
                <span class="rst-scan-tag hard">HARD</span>
                <span class="rst-scan-stat">${escapeHtml(l.stat)}</span>
                <span class="rst-scan-cap">${l.cap}%</span>
                ${reason ? `<div class="rst-scan-why">${reason}</div>` : ""}
            </div>`;
        }).join("");
        const softRows = (r.softLocks || []).map((l) => {
    if (!rstScope10.isCurrent()) return;

            totalSoft++;
            const cond = escapeHtml(l.condition || "");
            return `<div class="rst-scan-lock">
                <span class="rst-scan-tag soft">SOFT</span>
                <span class="rst-scan-stat">${escapeHtml(l.stat)}</span>
                <span class="rst-scan-cap">${l.cap}%</span>
                ${cond ? `<div class="rst-scan-why">until: ${cond}</div>` : ""}
            </div>`;
        }).join("");
        const count = (r.hardLocks?.length || 0) + (r.softLocks?.length || 0);
        charBlocks.push(`
            <details class="rst-scan-char">
                <summary><input type="checkbox" class="rst-scan-pick" data-charid="${r.characterId}" checked onclick="event.stopPropagation()"><span class="rst-scan-name">${$("<div>").text(r.characterName).html()}</span><span class="rst-scan-count">${count}</span></summary>
                <div class="rst-scan-locks">${hardRows}${softRows}</div>
            </details>`);
    }
    const html = `
        <div class="rst-scan-review">
            <div class="rst-scan-summary">Proposed <b>${totalHard}</b> hard and <b>${totalSoft}</b> soft lock${(totalHard + totalSoft) === 1 ? "" : "s"} across <b>${results.length}</b> character${results.length === 1 ? "" : "s"}. Untick any character to exclude it. Closing this keeps the scan so you can review it again later; tick "Discard" to throw it away.</div>
            ${charBlocks.join("")}
            <label class="rst-scan-discard"><input type="checkbox" id="rst-scan-discard-chk"> Discard this scan instead of keeping it</label>
        </div>`;
    const popup = new Popup(html, POPUP_TYPE.CONFIRM, "", { okButton: "Apply selected", cancelButton: "Close" });
    const showPromise = popup.show();
    const $dlg = $(popup.dlg);
    const proceedResult = await rstScope10.wait(() => (showPromise));
    const proceed = proceedResult === POPUP_RESULT.AFFIRMATIVE;

    const discardChecked = !!($dlg.find("#rst-scan-discard-chk")[0]?.checked);

    if (!proceed) {
        // Closed/Esc. Honor an explicit discard; otherwise keep for re-review.
        if (discardChecked) {
            savePendingLockScan(null);
            $("#rst-review-scan-btn").hide();
            toastr?.info?.("Scan discarded.");
        } else {
            toastr?.info?.("Scan kept — reopen it any time with Review.");
        }
        return;
    }

    const selectedIds = new Set();
    $dlg.find(".rst-scan-pick").each(function () {
    if (!rstScope10.isCurrent()) return;

        if (this.checked && this.dataset.charid) selectedIds.add(this.dataset.charid);
    });

    const { getCharacterProfile, updateCharacterProfile } = await rstScope10.wait(() => (import("../data/characters.js")));
    let appliedHard = 0, appliedSoft = 0, skippedChars = 0;
    for (const r of results) {
        if (!selectedIds.has(r.characterId)) { skippedChars++; continue; }
        const prof = getCharacterProfile(r.characterId);
        if (!prof) continue;
        if (!(prof.description && prof.description.trim())) continue;
        if (prof.hardLocks) {
            for (const l of (r.hardLocks || [])) {
                const [cat, stat] = String(l.stat).split(".");
                if (!prof.hardLocks[cat] || !prof.hardLocks[cat][stat]) continue;
                const cur = prof.hardLocks[cat][stat].cap;
                const softSlot = prof.softLocks?.[cat]?.[stat];
                const softOccupied = softSlot && typeof softSlot.cap === "number";
                if (cur === null && !softOccupied) {
                    prof.hardLocks[cat][stat] = { cap: l.cap, reason: l.reason || "Lock scan" };
                    appliedHard++;
                }
            }
            updateCharacterProfile(r.characterId, { hardLocks: prof.hardLocks });
        }
        if (prof.softLocks) {
            const { getSoftLockAvailability } = await rstScope10.wait(() => (import("../data/characters.js")));
            const { getClosedSceneCountForChar } = await rstScope10.wait(() => (import("../data/scenes.js")));
            const sceneCount = getClosedSceneCountForChar(r.characterId);
            const avail = getSoftLockAvailability(prof, sceneCount);
            if (avail.allowed) {
                let addedForChar = 0;
                for (const l of (r.softLocks || [])) {
                    if (addedForChar >= avail.slotsFree) break;
                    const [cat, stat] = String(l.stat).split(".");
                    const slot = prof.softLocks[cat]?.[stat];
                    if (!slot) continue;
                    const hardSlot = prof.hardLocks?.[cat]?.[stat];
                    const hardOccupied = hardSlot && typeof hardSlot.cap === "number";
                    if (slot.cap === null && !hardOccupied && l.condition && String(l.condition).trim()) {
                        prof.softLocks[cat][stat] = { cap: l.cap, condition: l.condition || "", progress: l.progress || "", met: false, setAtScene: sceneCount };
                        appliedSoft++;
                        addedForChar++;
                    }
                }
                updateCharacterProfile(r.characterId, { softLocks: prof.softLocks });
            }
        }
    }
    // Applied — clear the pending scan and hide the Review button.
    savePendingLockScan(null);
    $("#rst-review-scan-btn").hide();
    toastr?.success?.(`Applied ${appliedHard} hard + ${appliedSoft} soft lock${(appliedHard + appliedSoft) === 1 ? "" : "s"}${skippedChars > 0 ? ` · ${skippedChars} character(s) skipped` : ""}.`, "Relationship Stat Tracker");
}

// ─── Connection Profiles ──────────────────────────────────

function renderConnectionProfiles($card, settings) {
    ensureConnectionProfileRefresh();
    const $twoCol = $(`
        <div class="rst-two-col" style="margin-bottom:10px">
            <div>
                <div style="font-size:12px;color:var(--rst-text-muted);margin-bottom:4px">Stat update LLM</div>
                <select id="rst-conn-stat" style="width:100%"></select>
            </div>
            <div>
                <div style="font-size:12px;color:var(--rst-text-muted);margin-bottom:4px">Sidecar detection LLM</div>
                <select id="rst-conn-sidecar" style="width:100%"></select>
            </div>
        </div>
    `);

    const $autoGen = $(`
        <div>
            <div style="font-size:12px;color:var(--rst-text-muted);margin-bottom:4px">Auto-gen profile LLM</div>
            <select id="rst-conn-autogen" style="width:55%"></select>
        </div>
    `);

    $card.append($twoCol);
    $card.append($autoGen);

    // No-think (per connection profile)
    const $noThink = $(`
        <div style="margin-top:14px;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:var(--rst-text-muted)">No-think (per profile)</div>
        <div style="font-size:11px;color:var(--rst-text-faint,#999);margin:4px 0 8px;line-height:1.4">
            Soft appends <code>/no_think</code> (safe, ignored if unsupported). Hard also sends API params (<code>think</code>/<code>enable_thinking=false</code>) — turn off if your backend errors.
        </div>
        <div id="rst-nothink-rows"></div>
    `);
    $card.append($noThink);

    const RST_NT_ROLES = {
        statUpdateLLM: "Stat update",
        sidecarLLM: "Sidecar detection",
        autoGenLLM: "Auto-gen profile",
    };
    function rstRenderNoThinkRows() {
        const $rows = $card.find("#rst-nothink-rows");
        if (!$rows.length) return;
        const conns = settings.connections || {};
        const softMap = (settings.noThinkProfiles && typeof settings.noThinkProfiles === "object") ? settings.noThinkProfiles : {};
        const hardMap = (settings.noThinkHardProfiles && typeof settings.noThinkHardProfiles === "object") ? settings.noThinkHardProfiles : {};
        $rows.empty();
        Object.keys(RST_NT_ROLES).forEach(roleKey => {
            const pid = conns[roleKey] || "";
            const dis = pid ? "" : "disabled";
            const label = pid ? RST_NT_ROLES[roleKey] : `${RST_NT_ROLES[roleKey]} <span style="color:#a66">(no profile)</span>`;
            const $row = $(`
                <div style="display:flex;align-items:center;gap:14px;padding:5px 0;border-bottom:0.5px solid #2a2a2a">
                    <span style="flex:1;font-size:12px;color:var(--rst-text-muted)">${label}</span>
                    <label style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--rst-text-faint,#999);cursor:pointer"><input type="checkbox" class="rst-nt-soft" ${softMap[pid] ? "checked" : ""} ${dis}> soft</label>
                    <label style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--rst-text-faint,#999);cursor:pointer"><input type="checkbox" class="rst-nt-hard" ${hardMap[pid] ? "checked" : ""} ${dis}> hard</label>
                </div>
            `);
            $row.find(".rst-nt-soft").on("change", function () {
                const m = (settings.noThinkProfiles && typeof settings.noThinkProfiles === "object") ? settings.noThinkProfiles : {};
                if (this.checked) m[pid] = true; else delete m[pid];
                settings.noThinkProfiles = m;
                saveSetting("noThinkProfiles", m);
            });
            $row.find(".rst-nt-hard").on("change", function () {
                const m = (settings.noThinkHardProfiles && typeof settings.noThinkHardProfiles === "object") ? settings.noThinkHardProfiles : {};
                if (this.checked) m[pid] = true; else delete m[pid];
                settings.noThinkHardProfiles = m;
                saveSetting("noThinkHardProfiles", m);
            });
            $rows.append($row);
        });
    }
    rstRenderNoThinkRows();

    bindConnectionDropdown(
        $card.find("#rst-conn-stat"),
        settings.connections?.statUpdateLLM || "",
        (profile) => { saveSetting("connections.statUpdateLLM", profile?.id || ""); if (settings.connections) settings.connections.statUpdateLLM = profile?.id || ""; rstRenderNoThinkRows(); },
    );
    bindConnectionDropdown(
        $card.find("#rst-conn-sidecar"),
        settings.connections?.sidecarLLM || "",
        (profile) => { saveSetting("connections.sidecarLLM", profile?.id || ""); if (settings.connections) settings.connections.sidecarLLM = profile?.id || ""; rstRenderNoThinkRows(); },
    );
    bindConnectionDropdown(
        $card.find("#rst-conn-autogen"),
        settings.connections?.autoGenLLM || "",
        (profile) => { saveSetting("connections.autoGenLLM", profile?.id || ""); if (settings.connections) settings.connections.autoGenLLM = profile?.id || ""; rstRenderNoThinkRows(); },
    );

    const $saveConnections = appendSectionSaveButton($card, "rst-save-connection-profiles", "Save Connection Profiles");
    $saveConnections.on("click", () => commitSectionNow($saveConnections, "Connection Profiles", () => {
        const statId = String($card.find("#rst-conn-stat").val() || settings.connections?.statUpdateLLM || "");
        const sidecarId = String($card.find("#rst-conn-sidecar").val() || settings.connections?.sidecarLLM || "");
        const autoGenId = String($card.find("#rst-conn-autogen").val() || settings.connections?.autoGenLLM || "");
        saveSetting("connections.statUpdateLLM", statId);
        saveSetting("connections.sidecarLLM", sidecarId);
        saveSetting("connections.autoGenLLM", autoGenId);
        saveSetting("noThinkProfiles", { ...(settings.noThinkProfiles || {}) });
        saveSetting("noThinkHardProfiles", { ...(settings.noThinkHardProfiles || {}) });
    }));
}

// ─── Batch Scan ───────────────────────────────────────────

function renderBatchScan($pane, settings) {
    const bs = settings.batchScan || {};

    const $card = $(`
        <div class="rst-card">
            <div style="font-size:12px;color:var(--rst-text-muted);margin-bottom:10px;line-height:1.5">
                Scan existing or long chats to auto-detect scenes and characters. Creates blank character profiles,
                scene summaries, and an initial stat block per character. Runs once — does not compound on existing data.
            </div>
            <button class="rst-btn rst-batch-scan-btn" id="rst-batch-scan">Run Batch Scan</button>

            <div id="rst-batch-progress" style="display:none;margin-top:10px">
                <div class="rst-progress-bar-container">
                    <div class="rst-progress-bar-fill" style="width:0%"></div>
                </div>
                <div class="rst-progress-phase">Phase 1/4: Initializing...</div>
                <div class="rst-progress-detail">Starting batch scan...</div>
                <div class="rst-progress-stats">Elapsed: 0s | API calls: 0/0</div>
            </div>

            <hr class="rst-div" style="margin:12px 0">

            <div class="rst-setting-row">
                <div>
                    <div class="rst-setting-label">Scene detection max tokens</div>
                    <div class="rst-setting-sub">Max tokens for scene boundary detection. Higher values give reasoning models room to think.</div>
                </div>
                <input type="number" min="1000" max="16000" step="500"
                    value="${bs.sceneDetectionMaxTokens ?? 4000}"
                    id="rst-bs-scene-tokens" style="width:100px;flex-shrink:0">
            </div>
            <div class="rst-setting-row">
                <div>
                    <div class="rst-setting-label">Initial stat max tokens</div>
                    <div class="rst-setting-sub">Max tokens for initial stat generation per chunk.</div>
                </div>
                <input type="number" min="1000" max="16000" step="500"
                    value="${bs.initialStatMaxTokens ?? 3000}"
                    id="rst-bs-stat-tokens" style="width:100px;flex-shrink:0">
            </div>
        </div>
    `);

    const $rateCard = $(`
        <div class="rst-card">
            <div class="rst-setting-label" style="margin-bottom:10px">Rate Limiting</div>
            <div class="rst-setting-row">
                <div>
                    <div class="rst-setting-label">Requests per minute</div>
                    <div class="rst-setting-sub">Max LLM API calls per minute per connection profile.</div>
                </div>
                <input type="number" min="1" max="60" step="1"
                    value="${bs.requestsPerMinute ?? 10}"
                    id="rst-bs-rpm" style="width:80px;flex-shrink:0">
            </div>
            <div class="rst-setting-row">
                <div>
                    <div class="rst-setting-label">Max retries</div>
                    <div class="rst-setting-sub">Times to retry on rate limit (429) or server errors (502/503).</div>
                </div>
                <input type="number" min="0" max="10" step="1"
                    value="${bs.maxRetries ?? 3}"
                    id="rst-bs-retries" style="width:80px;flex-shrink:0">
            </div>
            <div class="rst-setting-row">
                <div>
                    <div class="rst-setting-label">Base retry delay (ms)</div>
                    <div class="rst-setting-sub">Initial wait before first retry (doubles each attempt, capped at 60s).</div>
                </div>
                <input type="number" min="500" max="30000" step="500"
                    value="${bs.baseRetryDelay ?? 1000}"
                    id="rst-bs-delay" style="width:80px;flex-shrink:0">
            </div>
        </div>
    `);

    const $advCard = $(`
        <div class="rst-card">
            <div class="rst-setting-label" style="margin-bottom:10px">Advanced Throttling</div>
            <div class="rst-setting-row">
                <div>
                    <div class="rst-setting-label">Per-scene delay (ms)</div>
                    <div class="rst-setting-sub">Delay between Phase 4 stat generation calls to let the API cool down.</div>
                </div>
                <input type="number" min="0" max="10000" step="100"
                    value="${bs.perSceneDelay ?? 0}"
                    id="rst-bs-scene-delay" style="width:80px;flex-shrink:0">
            </div>
            <div class="rst-setting-row">
                <div>
                    <div class="rst-setting-label">Inter-phase delay (ms)</div>
                    <div class="rst-setting-sub">Delay between scene detection (Phase 1) and stat generation (Phase 4).</div>
                </div>
                <input type="number" min="0" max="30000" step="500"
                    value="${bs.interPhaseDelay ?? 0}"
                    id="rst-bs-phase-delay" style="width:80px;flex-shrink:0">
            </div>
            <div class="rst-setting-row" style="border-bottom:none">
                <div>
                    <div class="rst-setting-label">Combine ranges in single call</div>
                    <div class="rst-setting-sub">Send all unprocessed message ranges in one API call instead of one per range. Reduces overhead when messages fit in context window.</div>
                </div>
                <label class="rst-toggle">
                    <input type="checkbox" id="rst-bs-combine" ${bs.combineRanges !== false ? 'checked' : ''}>
                    <span class="rst-slider"></span>
                </label>
            </div>
        </div>
    `);

    $card.find("#rst-batch-scan").on("click", async function () {
    const rstScope11 = captureChatScope();

        const $btn = $(this);
        const $progress = $card.find("#rst-batch-progress");
        const $fill = $progress.find(".rst-progress-bar-fill");
        const $phase = $progress.find(".rst-progress-phase");
        const $detail = $progress.find(".rst-progress-detail");
        const $stats = $progress.find(".rst-progress-stats");

        $btn.prop("disabled", true);
        $btn.text("Scanning...");
        $progress.show();

        $fill.css("width", "0%");
        $phase.text("Phase 1/4: Initializing...");
        $detail.text("Starting batch scan...");
        $stats.text("Elapsed: 0s | API calls: 0/0");

        const { setProgressCallback, updateRateLimiterSettings } = await rstScope11.wait(() => (import("../llm/connections.js")));
        const currentSettings = getSettings();
        updateRateLimiterSettings(currentSettings.batchScan || {});

        setProgressCallback((data) => {
    if (!rstScope11.isCurrent()) return;

            const percent = data.total > 0 ? Math.round((data.current / data.total) * 100) : 0;
            $fill.css("width", percent + "%");
            $phase.text(`Phase ${data.phase}/${data.totalPhases}: ${data.label}`);
            $detail.text(data.detail || "");

            const elapsed = data.elapsed || 0;
            const secs = Math.floor(elapsed / 1000);
            const mins = Math.floor(secs / 60);
            const timeStr = mins > 0 ? `${mins}m ${secs % 60}s` : `${secs}s`;
            $stats.text(`Elapsed: ${timeStr} | API calls: ${data.current}/${data.total}`);
        });

        try {
            const { runBatchScan } = await rstScope11.wait(() => (import("../llm/batchScan.js")));
            const result = await rstScope11.wait(() => (runBatchScan()));

            setProgressCallback(null);

            if (result.scenesCreated > 0 || result.profilesCreated.length > 0) {
                $fill.css("width", "100%");
                $phase.text("Phase 4/4: Complete");
                $detail.text(`Done! ${result.scenesCreated} scenes created, ${result.profilesCreated.length} new profiles.`);
                $stats.text("Refreshing UI...");

                const { renderHomeTab } = await rstScope11.wait(() => (import("./home.js")));
                const { renderLibraryTab } = await rstScope11.wait(() => (import("./library.js")));
                const { renderScenesTab } = await rstScope11.wait(() => (import("./scenes.js")));
                const { getPane } = await rstScope11.wait(() => (import("./panel.js")));

                renderHomeTab(getPane("home"));
                renderLibraryTab(getPane("lib"));
                renderScenesTab(getPane("scenes"));
            } else {
                $phase.text("Scan complete");
                $detail.text("No new scenes or profiles were created.");
            }
        } catch (err) {
            console.error("[RST] Batch scan failed:", err);
            const { setProgressCallback } = await rstScope11.wait(() => (import("../llm/connections.js")));
            setProgressCallback(null);
            $detail.text("Batch scan failed. Check console for details.");
            toastr?.error?.("Batch scan failed. See console for details.");
        } finally {
            $(document).trigger("rst:refresh-message-buttons");
            $btn.prop("disabled", false);
            $btn.text("Run batch scan");
        }
    });

    $card.find("#rst-bs-scene-tokens").on("change", async function () {
    const rstScope12 = captureChatScope();

        saveSetting("batchScan.sceneDetectionMaxTokens", parseInt($(this).val(), 10));
    });
    $card.find("#rst-bs-stat-tokens").on("change", async function () {
    const rstScope13 = captureChatScope();

        saveSetting("batchScan.initialStatMaxTokens", parseInt($(this).val(), 10));
    });
    $rateCard.find("#rst-bs-rpm").on("change", async function () {
    const rstScope14 = captureChatScope();

        saveSetting("batchScan.requestsPerMinute", parseInt($(this).val(), 10));
        const { updateRateLimiterSettings } = await rstScope14.wait(() => (import("../llm/connections.js")));
        updateRateLimiterSettings(getSettings().batchScan || {});
    });
    $rateCard.find("#rst-bs-retries").on("change", async function () {
    const rstScope15 = captureChatScope();

        saveSetting("batchScan.maxRetries", parseInt($(this).val(), 10));
        const { updateRateLimiterSettings } = await rstScope15.wait(() => (import("../llm/connections.js")));
        updateRateLimiterSettings(getSettings().batchScan || {});
    });
    $rateCard.find("#rst-bs-delay").on("change", async function () {
    const rstScope16 = captureChatScope();

        saveSetting("batchScan.baseRetryDelay", parseInt($(this).val(), 10));
        const { updateRateLimiterSettings } = await rstScope16.wait(() => (import("../llm/connections.js")));
        updateRateLimiterSettings(getSettings().batchScan || {});
    });
    $advCard.find("#rst-bs-scene-delay").on("change", async function () {
    const rstScope17 = captureChatScope();

        saveSetting("batchScan.perSceneDelay", parseInt($(this).val(), 10));
    });
    $advCard.find("#rst-bs-phase-delay").on("change", async function () {
    const rstScope18 = captureChatScope();

        saveSetting("batchScan.interPhaseDelay", parseInt($(this).val(), 10));
    });
    $advCard.find("#rst-bs-combine").on("change", async function () {
    const rstScope19 = captureChatScope();

        saveSetting("batchScan.combineRanges", $(this).is(":checked"));
    });

    $pane.append($card);
    $pane.append($rateCard);
    $pane.append($advCard);

    const $saveBatch = appendSectionSaveButton($advCard, "rst-save-batch-settings", "Save Batch Scan Settings");
    $saveBatch.on("click", () => commitSectionNow($saveBatch, "Batch Scan settings", async () => {
        const readInt = ($el, fallback, min, max) => {
            let value = parseInt($el.val(), 10);
            if (!Number.isFinite(value)) value = fallback;
            value = Math.max(min, Math.min(max, value));
            $el.val(value);
            return value;
        };

        const next = {
            sceneDetectionMaxTokens: readInt($card.find("#rst-bs-scene-tokens"), 4000, 1000, 16000),
            initialStatMaxTokens: readInt($card.find("#rst-bs-stat-tokens"), 3000, 1000, 16000),
            requestsPerMinute: readInt($rateCard.find("#rst-bs-rpm"), 10, 1, 60),
            maxRetries: readInt($rateCard.find("#rst-bs-retries"), 3, 0, 10),
            baseRetryDelay: readInt($rateCard.find("#rst-bs-delay"), 1000, 500, 30000),
            perSceneDelay: readInt($advCard.find("#rst-bs-scene-delay"), 0, 0, 10000),
            interPhaseDelay: readInt($advCard.find("#rst-bs-phase-delay"), 0, 0, 30000),
            combineRanges: $advCard.find("#rst-bs-combine").is(":checked"),
        };
        saveSetting("batchScan", { ...(getSettings().batchScan || {}), ...next });
        const { updateRateLimiterSettings } = await import("../llm/connections.js");
        updateRateLimiterSettings(getSettings().batchScan || {});
    }));
}

// ─── Scene Summary Prompt ─────────────────────────────────

function renderSceneSummaryPrompt($pane, settings) {
    const $card = $(`
        <div class="rst-card">
            <div style="font-size:12px;color:var(--rst-text-muted);margin-bottom:8px;line-height:1.5">
                Customize how the LLM writes scene summaries. These are internal notes only — never injected into your main prompt.
            </div>
            <textarea rows="4" style="margin-bottom:8px" id="rst-summary-prompt">${settings.sceneSummaryPrompt || ""}</textarea>
            <div style="font-size:11px;color:var(--rst-text-muted);margin-bottom:8px;padding:6px 8px;background:var(--rst-info-bg,#EEEDFE);border-radius:6px;line-height:1.4">
                ⚠ Importing a prompt will overwrite your current scene summary prompt. Export saves it as a .txt file for backup or sharing.
            </div>
            <div class="rst-btn-row">
                <button class="rst-btn" id="rst-import-prompt">Import</button>
                <button class="rst-btn" id="rst-export-prompt">Export</button>
            </div>
        </div>
    `);

    $card.find("#rst-summary-prompt").on("change", function () {
        saveSetting("sceneSummaryPrompt", $(this).val());
    });

    $card.find("#rst-export-prompt").on("click", () => {
        const text = $("#rst-summary-prompt").val();
        const blob = new Blob([text], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const _cn2 = String(getContext()?.name2 || "chat").replace(/[^a-zA-Z0-9 _-]/g, "").trim().replace(/\s+/g, "_") || "chat";
        a.download = `rst-summary-prompt-${_cn2}.txt`;
        a.click();
        URL.revokeObjectURL(url);
    });

    $card.find("#rst-import-prompt").on("click", () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".txt";
        input.onchange = async (e) => {
    const rstScope20 = captureChatScope();

            const file = e.target.files[0];
            if (!file) return;
            const text = await rstScope20.wait(() => (file.text()));
            $("#rst-summary-prompt").val(text);
            saveSetting("sceneSummaryPrompt", text);
        };
        input.click();
    });

    const $saveSummary = appendSectionSaveButton($card, "rst-save-scene-summary", "Save Scene Summary Prompt");
    $saveSummary.on("click", () => commitSectionNow($saveSummary, "Scene Summary Prompt", () => {
        saveSetting("sceneSummaryPrompt", String($card.find("#rst-summary-prompt").val() || ""));
    }));

    $pane.append($card);
}

// ─── Stat Settings ────────────────────────────────────────

function renderStatSettings($pane, settings) {
    const range = settings.statChangeRange || { min: -5, max: 5 };
    const crit = settings.criticalChanges || { enabled: true, chance: 7, multiplier: 3 };
    const $card = $(`
        <div class="rst-card">
            <div class="rst-setting-row">
                <div>
                    <div class="rst-setting-label">Stat change range</div>
                    <div class="rst-setting-sub">Maximum points a stat can shift up or down per scene close</div>
                </div>
                <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
                    <input type="number" id="rst-range-min" value="${range.min}" min="-20" max="0" style="width:52px;text-align:center">
                    <span style="font-size:12px;color:var(--rst-text-muted)">to</span>
                    <input type="number" id="rst-range-max" value="${range.max}" min="0" max="20" style="width:52px;text-align:center">
                </div>
            </div>
            <div class="rst-setting-row">
                <div>
                    <div class="rst-setting-label">Critical changes</div>
                    <div class="rst-setting-sub">On pivotal moments, a flagged stat can shift up to ${crit.multiplier || 3}\u00d7 the normal range. RNG-gated and rare.</div>
                </div>
                <label class="rst-toggle"><input type="checkbox" id="rst-crit-enabled" ${crit.enabled !== false ? "checked" : ""}><span class="rst-slider"></span></label>
            </div>
            <div class="rst-setting-row">
                <div>
                    <div class="rst-setting-label">Critical chance</div>
                    <div class="rst-setting-sub">Percent chance a flagged stat actually goes critical (lower = rarer)</div>
                </div>
                <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
                    <input type="number" id="rst-crit-chance" value="${crit.chance ?? 7}" min="0" max="100" style="width:56px;text-align:center">
                    <span style="font-size:12px;color:var(--rst-text-muted)">%</span>
                </div>
            </div>
            <div class="rst-setting-row">
                <div>
                    <div class="rst-setting-label">Hard locks</div>
                    <div class="rst-setting-sub">Enforce per-stat caps based on a character\'s psychology. Normal growth stops at the cap; only a critical can push past and raise it. <b>Requires the character\'s Personality field to be filled</b> \u2014 locks will not be set for a character whose Personality is empty.</div>
                </div>
                <label class="rst-toggle"><input type="checkbox" id="rst-hardlocks-enabled" ${(settings.hardLocks?.enabled !== false) ? "checked" : ""}><span class="rst-slider"></span></label>
            </div>
            <div class="rst-setting-row">
                <div>
                    <div class="rst-setting-label">Soft locks</div>
                    <div class="rst-setting-sub">Conditional caps that gate growth until an LLM-defined milestone is met, then auto-unlock. <b>Requires the character\'s Personality field to be filled.</b></div>
                </div>
                <label class="rst-toggle"><input type="checkbox" id="rst-softlocks-enabled" ${(settings.softLocks?.enabled !== false) ? "checked" : ""}><span class="rst-slider"></span></label>
            </div>
            <div class="rst-setting-row">
                <div>
                    <div class="rst-setting-label">Max active soft locks</div>
                    <div class="rst-setting-sub">Ceiling on simultaneous active soft locks per character (1-3). A maximum, not a target \u2014 the LLM still uses judgment and often sets fewer or none.</div>
                </div>
                <input type="number" id="rst-softlocks-max" value="${settings.softLocks?.maxActive ?? 1}" min="1" max="3" style="width:56px;text-align:center;flex-shrink:0">
            </div>
            <div class="rst-setting-row" style="border-bottom:none;justify-content:flex-end">
                <button id="rst-save-stat-settings" class="rst-btn"><i class="fa-solid fa-floppy-disk"></i> Save Stat Settings</button>
            </div>
        </div>
    `);

    // Commit the range explicitly as one object. Per-input change/blur saving
    // could lose a typed value if the panel closed before the browser emitted
    // the field change event. The button snapshots the entire section and then
    // calls SillyTavern's immediate settings save instead of waiting on debounce.
    const $saveStatSettings = $card.find("#rst-save-stat-settings");
    $saveStatSettings.on("click", () => commitSectionNow($saveStatSettings, "Stat Settings", () => {
        let min = parseInt($card.find("#rst-range-min").val(), 10);
        let max = parseInt($card.find("#rst-range-max").val(), 10);
        let chance = parseInt($card.find("#rst-crit-chance").val(), 10);
        let maxSoftLocks = parseInt($card.find("#rst-softlocks-max").val(), 10);

        if (!Number.isFinite(min)) min = -5;
        if (!Number.isFinite(max)) max = 5;
        min = Math.max(-20, Math.min(0, min));
        max = Math.max(0, Math.min(20, max));
        if (!Number.isFinite(chance)) chance = 15;
        chance = Math.max(0, Math.min(100, chance));
        if (!Number.isFinite(maxSoftLocks)) maxSoftLocks = 1;
        maxSoftLocks = Math.max(1, Math.min(3, maxSoftLocks));

        $card.find("#rst-range-min").val(min);
        $card.find("#rst-range-max").val(max);
        $card.find("#rst-crit-chance").val(chance);
        $card.find("#rst-softlocks-max").val(maxSoftLocks);

        saveSetting("statChangeRange", { min, max });
        saveSetting("criticalChanges.enabled", $card.find("#rst-crit-enabled").prop("checked"));
        saveSetting("criticalChanges.chance", chance);
        saveSetting("hardLocks.enabled", $card.find("#rst-hardlocks-enabled").prop("checked"));
        saveSetting("softLocks.enabled", $card.find("#rst-softlocks-enabled").prop("checked"));
        saveSetting("softLocks.maxActive", maxSoftLocks);
    }));

    $card.find("#rst-crit-enabled").on("change", function () {
        saveSetting("criticalChanges.enabled", $(this).prop("checked"));
    });
    $card.find("#rst-crit-chance").on("change", function () {
        let v = parseInt($(this).val(), 10);
        if (isNaN(v) || v < 0) v = 0; if (v > 100) v = 100;
        $(this).val(v);
        saveSetting("criticalChanges.chance", v);
    });
    $card.find("#rst-hardlocks-enabled").on("change", function () {
        saveSetting("hardLocks.enabled", $(this).prop("checked"));
    });
    $card.find("#rst-softlocks-enabled").on("change", function () {
        saveSetting("softLocks.enabled", $(this).prop("checked"));
    });
    $card.find("#rst-softlocks-max").on("change", function () {
        let v = parseInt($(this).val(), 10);
        if (isNaN(v) || v < 1) v = 1; if (v > 3) v = 3;
        $(this).val(v);
        saveSetting("softLocks.maxActive", v);
    });

    $pane.append($card);
}

// ─── Detection Settings ───────────────────────────────────

function renderDetectionSettings($pane, settings) {
    const $card = $('<div class="rst-card"></div>');
    const freqOptions = [3, 5, 7, 10].map((n) =>
        `<option value="${n}"${n === (settings.scanFrequency || 5) ? " selected" : ""}>${n}</option>`
    ).join("");

    const msgScanOptions = [3, 5, 7, 10, 15].map((n) =>
        `<option value="${n}"${n === (settings.messagesToScan || 10) ? " selected" : ""}>${n}</option>`
    ).join("");

    $card.append(`
        <div class="rst-setting-row">
            <div><div class="rst-setting-label">Scan frequency</div><div class="rst-setting-sub">How often the sidecar LLM checks for character presence</div></div>
            <div style="display:flex;align-items:center;gap:8px;flex-shrink:0"><select id="rst-scan-freq" style="width:60px">${freqOptions}</select><span style="font-size:12px;color:var(--rst-text-muted)">msgs</span></div>
        </div>
        <div class="rst-setting-row">
            <div><div class="rst-setting-label">Messages to scan</div><div class="rst-setting-sub">How many recent messages the sidecar reads. Lower = tighter scenes, fewer concurrent locations. Higher = more context but may include characters from other scenes.</div></div>
            <div style="display:flex;align-items:center;gap:8px;flex-shrink:0"><select id="rst-msg-scan" style="width:60px">${msgScanOptions}</select><span style="font-size:12px;color:var(--rst-text-muted)">msgs</span></div>
        </div>
    `);
    $card.append(`
        <div class="rst-setting-row">
            <div><div class="rst-setting-label">New character popup</div><div class="rst-setting-sub">Prompt before creating an unknown character. When off, unknown names are ignored; existing profiles are still tracked.</div></div>
            <label class="rst-toggle"><input type="checkbox" id="rst-new-char-popup" ${settings.newCharPopup !== false ? "checked" : ""}><span class="rst-slider"></span></label>
        </div>
    `);

    const blacklistStr = (getNameBlacklist() || []).join(", ");
    $card.append(`
        <div class="rst-setting-row" style="border-bottom:none"><div><div class="rst-setting-label">Name blacklist</div><div class="rst-setting-sub">Names to always exclude from sidecar detection (comma or newline separated). Also excludes your ST user persona name automatically.</div></div></div>
        <div style="padding:0 0 4px"><textarea id="rst-name-blacklist" rows="2" style="width:100%;font-size:12px" placeholder="e.g. Narrator, Guide, System">${escapeHtml(blacklistStr)}</textarea></div>
        <div class="rst-name-blacklist-actions">
            <button id="rst-save-name-blacklist" class="rst-btn rst-save-blacklist-btn" type="button"><i class="fa-solid fa-floppy-disk"></i><span>Save blacklist</span></button>
            <span id="rst-name-blacklist-status" class="rst-name-blacklist-status" aria-live="polite"></span>
        </div>
    `);
    const $saveDetection = appendSectionSaveButton($card, "rst-save-detection-settings", "Save Detection Settings");

    $pane.append($card);

    const $scanFrequency = $card.find("#rst-scan-freq");
    const $messagesToScan = $card.find("#rst-msg-scan");
    const $newCharacterPopup = $card.find("#rst-new-char-popup");
    const $blacklistInput = $card.find("#rst-name-blacklist");
    const $blacklistButton = $card.find("#rst-save-name-blacklist");
    const $blacklistStatus = $card.find("#rst-name-blacklist-status");

    $scanFrequency.on("change", function () { saveSetting("scanFrequency", parseInt($(this).val(), 10)); });
    $messagesToScan.on("change", function () { saveSetting("messagesToScan", parseInt($(this).val(), 10)); });
    $newCharacterPopup.on("change", function () { saveSetting("newCharPopup", $(this).prop("checked")); });

    async function saveBlacklist(immediate = false) {
    const rstScope21 = captureChatScope();

        const $button = $blacklistButton;
        const $status = $blacklistStatus;
        const raw = $blacklistInput.val();
        const list = parseNameBlacklist(raw);

        if (immediate) {
            $button.prop("disabled", true).addClass("is-saving");
            $button.find("span").text("Saving...");
            $status.text("Saving...");
        }

        let saved = false;
        try {
            saved = await rstScope21.wait(() => (Promise.resolve(saveNameBlacklist(list, immediate))));
            $blacklistInput.val((getNameBlacklist() || []).join(", "));
        } catch (err) {
            console.warn("[RST] Failed to save name blacklist.", err);
        }

        if (!immediate) {
            $status.text(saved === false ? "Unsaved" : "Queued");
            return;
        }

        $button.prop("disabled", false).removeClass("is-saving");
        $button.find("span").text("Save blacklist");

        if (saved === false) {
            $status.text("Save failed");
            toastr?.error?.("Name blacklist could not be saved. Check the console for details.", "Relationship Stat Tracker");
        } else {
            $status.text("Saved");
            const count = (getNameBlacklist() || []).length;
            toastr?.success?.(`Name blacklist saved (${count} entr${count === 1 ? "y" : "ies"}).`, "Relationship Stat Tracker");
        }

        setTimeout(() => $status.text(""), 1800);
    }

    $blacklistInput.on("change", function () { saveBlacklist(false); });
    $blacklistInput.on("input", function () {
        $blacklistStatus.text("Unsaved");
    });
    $blacklistButton.on("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        saveBlacklist(true);
    });

    $saveDetection.on("click", () => commitSectionNow($saveDetection, "Detection Settings", async () => {
        saveSetting("scanFrequency", parseInt($scanFrequency.val(), 10) || 5);
        saveSetting("messagesToScan", parseInt($messagesToScan.val(), 10) || 10);
        saveSetting("newCharPopup", $newCharacterPopup.prop("checked"));

        const savedBlacklist = await Promise.resolve(saveNameBlacklist(parseNameBlacklist($blacklistInput.val()), true));
        if (savedBlacklist === false) throw new Error("Name blacklist could not be persisted.");
        $blacklistInput.val((getNameBlacklist() || []).join(", "));
        $blacklistStatus.text("Saved");
        setTimeout(() => $blacklistStatus.text(""), 1800);
    }));
}

// ─── Injection Settings ───────────────────────────────────

function renderInjectionSettings($pane, settings) {
    const inj = settings.injection || {};
    const $card = $('<div class="rst-card"></div>');

    $card.append(`<div class="rst-setting-row"><div><div class="rst-setting-label">Inject stat block</div><div class="rst-setting-sub">Inject character stats into system prompt when present in context</div></div><label class="rst-toggle"><input type="checkbox" id="rst-inject-stats" ${inj.injectStats !== false ? "checked" : ""}><span class="rst-slider"></span></label></div>`);
    $card.append(`<div class="rst-setting-row"><div><div class="rst-setting-label">Inject character profile</div><div class="rst-setting-sub">Also inject name, description, and notes — uses more tokens</div></div><label class="rst-toggle"><input type="checkbox" id="rst-inject-profile" ${inj.injectProfile !== false ? "checked" : ""}><span class="rst-slider"></span></label></div>`);

    const formatOptions = [{ value: "stats_only", label: "Stats only" },{ value: "stats_and_narrative", label: "Stats + narrative" }].map((o) => `<option value="${o.value}"${o.value === (inj.format || "stats_and_narrative") ? " selected" : ""}>${o.label}</option>`).join("");
    $card.append(`<div class="rst-setting-row"><div><div class="rst-setting-label">Injection format</div><div class="rst-setting-sub">What gets included in the injected block</div></div><select id="rst-inject-format" style="width:160px;flex-shrink:0">${formatOptions}</select></div>`);

    const placementOptions = [{ value: "top", label: "Before main prompt (legacy top)" },{ value: "above_card", label: "Before main prompt" },{ value: "below_card", label: "After main prompt" }].map((o) => `<option value="${o.value}"${o.value === (inj.placement || "above_card") ? " selected" : ""}>${o.label}</option>`).join("");
    $card.append(`<div class="rst-setting-row"><div><div class="rst-setting-label">Injection placement</div><div class="rst-setting-sub">Before or after the main prompt; exact card order follows your preset</div></div><select id="rst-inject-placement" style="width:160px;flex-shrink:0">${placementOptions}</select></div>`);

    const roleOptions = [{ value: "system", label: "System" },{ value: "user", label: "User" },{ value: "assistant", label: "Assistant" }].map((o) => `<option value="${o.value}"${(o.value === (inj.libraryRefRole || "system")) ? " selected" : ""}>${o.label}</option>`).join("");
    $card.append(`<div class="rst-setting-row" style="border-top:1px solid var(--rst-border);padding-top:12px;margin-top:4px"><div><div class="rst-setting-label">Passive library reference</div><div class="rst-setting-sub">Inject library as freely-referenceable context — LLM can reference any tracked character's full relationship data when relevant</div></div><label class="rst-toggle"><input type="checkbox" id="rst-passive-ref" ${inj.passiveLibraryRef ? "checked" : ""}><span class="rst-slider"></span></label></div>`);
    $card.append(`<div class="rst-setting-row"><div><div class="rst-setting-label">Stat lookup tool (function calling)</div><div class="rst-setting-sub">Lets the main LLM request a character's stats on demand — even when they aren't present. Requires a Chat Completion backend with tool calling enabled.</div></div><label class="rst-toggle"><input type="checkbox" id="rst-stat-tool" ${inj.statToolEnabled !== false ? "checked" : ""}><span class="rst-slider"></span></label></div>`);
    $card.append(`<div class="rst-setting-row"><div><div class="rst-setting-label">Library reference depth</div><div class="rst-setting-sub">Chat depth counted backward from the newest message</div></div><select id="rst-ref-depth" style="width:160px;flex-shrink:0"><option value="0"${(inj.libraryRefDepth === 0) ? " selected" : ""}>Depth 0 (newest)</option><option value="1"${(inj.libraryRefDepth === 1 || inj.libraryRefDepth === undefined) ? " selected" : ""}>Depth 1</option><option value="2"${(inj.libraryRefDepth === 2) ? " selected" : ""}>Depth 2</option></select></div>`);
    $card.append(`<div class="rst-setting-row"><div><div class="rst-setting-label">Library reference role</div><div class="rst-setting-sub">Speaker role for the injected library block</div></div><select id="rst-ref-role" style="width:160px;flex-shrink:0">${roleOptions}</select></div>`);
    const $saveInjection = appendSectionSaveButton($card, "rst-save-injection-settings", "Save Injection Settings");

    $pane.append($card);

    $("#rst-inject-stats").on("change", async function () {
    const rstScope22 = captureChatScope();
 saveSetting("injection.injectStats", $(this).prop("checked")); const { updateInjection } = await rstScope22.wait(() => (import("../inject/promptInjector.js"))); updateInjection(); });
    $("#rst-inject-profile").on("change", async function () {
    const rstScope23 = captureChatScope();
 saveSetting("injection.injectProfile", $(this).prop("checked")); const { updateInjection } = await rstScope23.wait(() => (import("../inject/promptInjector.js"))); updateInjection(); });
    $("#rst-inject-format").on("change", async function () {
    const rstScope24 = captureChatScope();
 saveSetting("injection.format", $(this).val()); const { updateInjection } = await rstScope24.wait(() => (import("../inject/promptInjector.js"))); updateInjection(); });
    $("#rst-inject-placement").on("change", async function () {
    const rstScope25 = captureChatScope();
 saveSetting("injection.placement", $(this).val()); const { updateInjection } = await rstScope25.wait(() => (import("../inject/promptInjector.js"))); updateInjection(); });
    $("#rst-passive-ref").on("change", async function () {
    const rstScope26 = captureChatScope();
 saveSetting("injection.passiveLibraryRef", $(this).prop("checked")); const { updateInjection } = await rstScope26.wait(() => (import("../inject/promptInjector.js"))); updateInjection(); });
    $("#rst-stat-tool").on("change", function () { saveSetting("injection.statToolEnabled", $(this).prop("checked")); });
    $("#rst-ref-depth").on("change", async function () {
    const rstScope27 = captureChatScope();
 saveSetting("injection.libraryRefDepth", parseInt($(this).val(), 10)); const { updateInjection } = await rstScope27.wait(() => (import("../inject/promptInjector.js"))); updateInjection(); });
    $("#rst-ref-role").on("change", async function () {
    const rstScope28 = captureChatScope();
 saveSetting("injection.libraryRefRole", $(this).val()); const { updatePassiveLibraryRef } = await rstScope28.wait(() => (import("../inject/promptInjector.js"))); updatePassiveLibraryRef(); });

    $saveInjection.on("click", () => commitSectionNow($saveInjection, "Injection Settings", async () => {
        saveSetting("injection.injectStats", $card.find("#rst-inject-stats").prop("checked"));
        saveSetting("injection.injectProfile", $card.find("#rst-inject-profile").prop("checked"));
        saveSetting("injection.format", String($card.find("#rst-inject-format").val() || "stats_and_narrative"));
        saveSetting("injection.placement", String($card.find("#rst-inject-placement").val() || "above_card"));
        saveSetting("injection.passiveLibraryRef", $card.find("#rst-passive-ref").prop("checked"));
        saveSetting("injection.statToolEnabled", $card.find("#rst-stat-tool").prop("checked"));
        saveSetting("injection.libraryRefDepth", parseInt($card.find("#rst-ref-depth").val(), 10) || 0);
        saveSetting("injection.libraryRefRole", String($card.find("#rst-ref-role").val() || "system"));

        const { updateInjection, updatePassiveLibraryRef } = await import("../inject/promptInjector.js");
        updateInjection();
        updatePassiveLibraryRef();
    }));
}

// ─── Data Section ─────────────────────────────────────────

function renderDataSection($pane) {
    const settings = getSettings();
    const configuredMilestonesPerPage = Number.parseInt(settings.milestonesPerPage, 10);
    const milestonesPerPage = Number.isFinite(configuredMilestonesPerPage)
        ? Math.min(50, Math.max(1, configuredMilestonesPerPage))
        : 5;
    const $displayCard = $(
        `<div class="rst-card">
            <div class="rst-setting-row">
                <div>
                    <div class="rst-setting-label">Milestones per page</div>
                    <div class="rst-setting-sub">Number of relationship milestones shown at once in each Character Library profile.</div>
                </div>
                <input type="number" id="rst-milestones-per-page" min="1" max="50" step="1" value="${milestonesPerPage}" style="width:72px">
            </div>
        </div>`
    );
    $displayCard.find("#rst-milestones-per-page").on("change", function () {
        const value = Math.min(50, Math.max(1, Number.parseInt($(this).val(), 10) || 5));
        $(this).val(value);
        saveSetting("milestonesPerPage", value);
        toastr?.success?.(`Character Library will show ${value} milestone${value === 1 ? "" : "s"} per page.`);
    });

    const $btnRow = $(`<div class="rst-btn-row"><button class="rst-btn" id="rst-import-all">Import all</button><button class="rst-btn" id="rst-export-all">Export all</button></div>`);

    $btnRow.find("#rst-export-all").on("click", async () => {
    const rstScope29 = captureChatScope();

        const data = await rstScope29.wait(() => (exportAllData()));
        const blob = new Blob([data], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const _cn = String(getContext()?.name2 || "chat").replace(/[^a-zA-Z0-9 _-]/g, "").trim().replace(/\s+/g, "_") || "chat";
        const a = document.createElement("a"); a.href = url; a.download = `rst-data-${_cn}-${Date.now()}.json`; a.click();
        URL.revokeObjectURL(url);
        toastr?.success?.("All data exported.");
    });

    $btnRow.find("#rst-import-all").on("click", () => {
        const input = document.createElement("input"); input.type = "file"; input.accept = ".json";
        input.onchange = async (e) => {
    const rstScope30 = captureChatScope();

            const file = e.target.files[0]; if (!file) return;
            const text = await rstScope30.wait(() => (file.text()));
            const success = await importAllData(text);
            if (success) { toastr?.success?.("Data imported successfully."); renderSettingsTab(getPane("settings")); }
            else { toastr?.error?.("Failed to import data."); }
        };
        input.click();
    });

    $pane.append($displayCard, $btnRow);
}
