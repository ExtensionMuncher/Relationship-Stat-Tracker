/**
 * settings.js — Settings tab: all config UI
 * Renders the Settings tab with accordion-collapsed sections (NWST-style)
 * Connection Profiles are NOT accordion-wrapped to ensure ConnectionManager initializes properly
 */

import { getSettings, saveSetting, getNameBlacklist, saveNameBlacklist } from "../data/storage.js";
import { setSetting, isEnabled, exportAllData, importAllData } from "../settings.js";
import { ConnectionManagerRequestService } from "../../../../extensions/shared.js";
import { getContext } from "../../../../extensions.js";

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
        <div class="rst-setting-row" style="border-bottom:none">
            <div>
                <div class="rst-setting-label">Debug F12 logging</div>
                <div class="rst-setting-sub">Show RST activity logs in the browser console · warnings and errors always show</div>
            </div>
            <label class="rst-toggle"><input type="checkbox" id="rst-debug-toggle" ${settings.debug ? "checked" : ""}><span class="rst-slider"></span></label>
        </div>
    `);
    $pane.append($card);

    $("#rst-debug-toggle").on("change", function () {
        const on = $(this).prop("checked");
        saveSetting("debug", on);
        toastr?.info?.(`Debug logging ${on ? "enabled" : "disabled"}.`, "Relationship Stat Tracker");
    });
}

// ─── Connection Profiles ──────────────────────────────────

function renderConnectionProfiles($card, settings) {
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

    try {
        ConnectionManagerRequestService.handleDropdown(
            "#rst-conn-stat",
            settings.connections?.statUpdateLLM || "",
            (profile) => { saveSetting("connections.statUpdateLLM", profile?.id || ""); if (settings.connections) settings.connections.statUpdateLLM = profile?.id || ""; rstRenderNoThinkRows(); },
        );
    } catch (err) {
        console.warn("[RST] Connection Manager not available for stat update LLM:", err);
    }

    try {
        ConnectionManagerRequestService.handleDropdown(
            "#rst-conn-sidecar",
            settings.connections?.sidecarLLM || "",
            (profile) => { saveSetting("connections.sidecarLLM", profile?.id || ""); if (settings.connections) settings.connections.sidecarLLM = profile?.id || ""; rstRenderNoThinkRows(); },
        );
    } catch (err) {
        console.warn("[RST] Connection Manager not available for sidecar LLM:", err);
    }

    try {
        ConnectionManagerRequestService.handleDropdown(
            "#rst-conn-autogen",
            settings.connections?.autoGenLLM || "",
            (profile) => { saveSetting("connections.autoGenLLM", profile?.id || ""); if (settings.connections) settings.connections.autoGenLLM = profile?.id || ""; rstRenderNoThinkRows(); },
        );
    } catch (err) {
        console.warn("[RST] Connection Manager not available for auto-gen LLM:", err);
    }
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
            <button class="rst-btn" style="border-color:var(--rst-accent);color:var(--rst-avatar-text)" id="rst-batch-scan">Run batch scan</button>

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

        const { setProgressCallback, updateRateLimiterSettings } = await import("../llm/connections.js");
        const currentSettings = getSettings();
        updateRateLimiterSettings(currentSettings.batchScan || {});

        setProgressCallback((data) => {
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
            const { runBatchScan } = await import("../llm/batchScan.js");
            const result = await runBatchScan();

            setProgressCallback(null);

            if (result.scenesCreated > 0 || result.profilesCreated.length > 0) {
                $fill.css("width", "100%");
                $phase.text("Phase 4/4: Complete");
                $detail.text(`Done! ${result.scenesCreated} scenes created, ${result.profilesCreated.length} new profiles.`);
                $stats.text("Refreshing UI...");

                const { renderHomeTab } = await import("./home.js");
                const { renderLibraryTab } = await import("./library.js");
                const { renderScenesTab } = await import("./scenes.js");
                const { getPane } = await import("./panel.js");

                renderHomeTab(getPane("home"));
                renderLibraryTab(getPane("lib"));
                renderScenesTab(getPane("scenes"));
            } else {
                $phase.text("Scan complete");
                $detail.text("No new scenes or profiles were created.");
            }
        } catch (err) {
            console.error("[RST] Batch scan failed:", err);
            const { setProgressCallback } = await import("../llm/connections.js");
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
        saveSetting("batchScan.sceneDetectionMaxTokens", parseInt($(this).val(), 10));
    });
    $card.find("#rst-bs-stat-tokens").on("change", async function () {
        saveSetting("batchScan.initialStatMaxTokens", parseInt($(this).val(), 10));
    });
    $rateCard.find("#rst-bs-rpm").on("change", async function () {
        saveSetting("batchScan.requestsPerMinute", parseInt($(this).val(), 10));
        const { updateRateLimiterSettings } = await import("../llm/connections.js");
        updateRateLimiterSettings(getSettings().batchScan || {});
    });
    $rateCard.find("#rst-bs-retries").on("change", async function () {
        saveSetting("batchScan.maxRetries", parseInt($(this).val(), 10));
        const { updateRateLimiterSettings } = await import("../llm/connections.js");
        updateRateLimiterSettings(getSettings().batchScan || {});
    });
    $rateCard.find("#rst-bs-delay").on("change", async function () {
        saveSetting("batchScan.baseRetryDelay", parseInt($(this).val(), 10));
        const { updateRateLimiterSettings } = await import("../llm/connections.js");
        updateRateLimiterSettings(getSettings().batchScan || {});
    });
    $advCard.find("#rst-bs-scene-delay").on("change", async function () {
        saveSetting("batchScan.perSceneDelay", parseInt($(this).val(), 10));
    });
    $advCard.find("#rst-bs-phase-delay").on("change", async function () {
        saveSetting("batchScan.interPhaseDelay", parseInt($(this).val(), 10));
    });
    $advCard.find("#rst-bs-combine").on("change", async function () {
        saveSetting("batchScan.combineRanges", $(this).is(":checked"));
    });

    $pane.append($card);
    $pane.append($rateCard);
    $pane.append($advCard);
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
            const file = e.target.files[0];
            if (!file) return;
            const text = await file.text();
            $("#rst-summary-prompt").val(text);
            saveSetting("sceneSummaryPrompt", text);
        };
        input.click();
    });

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
        </div>
    `);

    $card.find("#rst-range-min").on("change", function () {
        saveSetting("statChangeRange.min", parseInt($(this).val(), 10));
    });
    $card.find("#rst-range-max").on("change", function () {
        saveSetting("statChangeRange.max", parseInt($(this).val(), 10));
    });
    $card.find("#rst-crit-enabled").on("change", function () {
        saveSetting("criticalChanges.enabled", $(this).prop("checked"));
    });
    $card.find("#rst-crit-chance").on("change", function () {
        let v = parseInt($(this).val(), 10);
        if (isNaN(v) || v < 0) v = 0; if (v > 100) v = 100;
        $(this).val(v);
        saveSetting("criticalChanges.chance", v);
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
            <div><div class="rst-setting-label">New character popup</div><div class="rst-setting-sub">Prompt for approval when an unknown character is detected</div></div>
            <label class="rst-toggle"><input type="checkbox" id="rst-new-char-popup" ${settings.newCharPopup !== false ? "checked" : ""}><span class="rst-slider"></span></label>
        </div>
    `);

    const blacklistStr = (getNameBlacklist() || []).join(", ");
    $card.append(`
        <div class="rst-setting-row" style="border-bottom:none"><div><div class="rst-setting-label">Name blacklist</div><div class="rst-setting-sub">Names to always exclude from sidecar detection (comma-separated). Also excludes your ST user persona name automatically.</div></div></div>
        <div style="padding:0 0 4px"><textarea id="rst-name-blacklist" rows="2" style="width:100%;font-size:12px" placeholder="e.g. Narrator, Guide, System">${blacklistStr}</textarea></div>
    `);

    $pane.append($card);

    $("#rst-scan-freq").on("change", function () { saveSetting("scanFrequency", parseInt($(this).val(), 10)); });
    $("#rst-msg-scan").on("change", function () { saveSetting("messagesToScan", parseInt($(this).val(), 10)); });
    $("#rst-new-char-popup").on("change", function () { saveSetting("newCharPopup", $(this).prop("checked")); });
    $("#rst-name-blacklist").on("change", function () {
        const raw = $(this).val();
        const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
        saveNameBlacklist(list);
    });
}

// ─── Injection Settings ───────────────────────────────────

function renderInjectionSettings($pane, settings) {
    const inj = settings.injection || {};
    const $card = $('<div class="rst-card"></div>');

    $card.append(`<div class="rst-setting-row"><div><div class="rst-setting-label">Inject stat block</div><div class="rst-setting-sub">Inject character stats into system prompt when present in context</div></div><label class="rst-toggle"><input type="checkbox" id="rst-inject-stats" ${inj.injectStats !== false ? "checked" : ""}><span class="rst-slider"></span></label></div>`);
    $card.append(`<div class="rst-setting-row"><div><div class="rst-setting-label">Inject character profile</div><div class="rst-setting-sub">Also inject name, description, and notes — uses more tokens</div></div><label class="rst-toggle"><input type="checkbox" id="rst-inject-profile" ${inj.injectProfile !== false ? "checked" : ""}><span class="rst-slider"></span></label></div>`);

    const formatOptions = [{ value: "stats_only", label: "Stats only" },{ value: "stats_and_narrative", label: "Stats + narrative" }].map((o) => `<option value="${o.value}"${o.value === (inj.format || "stats_and_narrative") ? " selected" : ""}>${o.label}</option>`).join("");
    $card.append(`<div class="rst-setting-row"><div><div class="rst-setting-label">Injection format</div><div class="rst-setting-sub">What gets included in the injected block</div></div><select id="rst-inject-format" style="width:160px;flex-shrink:0">${formatOptions}</select></div>`);

    const placementOptions = [{ value: "top", label: "Top of system prompt" },{ value: "above_card", label: "Above character card" },{ value: "below_card", label: "Below character card" }].map((o) => `<option value="${o.value}"${o.value === (inj.placement || "above_card") ? " selected" : ""}>${o.label}</option>`).join("");
    $card.append(`<div class="rst-setting-row"><div><div class="rst-setting-label">Injection placement</div><div class="rst-setting-sub">Where in the system prompt the block is inserted</div></div><select id="rst-inject-placement" style="width:160px;flex-shrink:0">${placementOptions}</select></div>`);

    const roleOptions = [{ value: "system", label: "System" },{ value: "user", label: "User" },{ value: "assistant", label: "Assistant" }].map((o) => `<option value="${o.value}"${(o.value === (inj.libraryRefRole || "system")) ? " selected" : ""}>${o.label}</option>`).join("");
    $card.append(`<div class="rst-setting-row" style="border-top:1px solid var(--rst-border);padding-top:12px;margin-top:4px"><div><div class="rst-setting-label">Passive library reference</div><div class="rst-setting-sub">Inject library as freely-referenceable context — LLM can reference any tracked character's full relationship data when relevant</div></div><label class="rst-toggle"><input type="checkbox" id="rst-passive-ref" ${inj.passiveLibraryRef ? "checked" : ""}><span class="rst-slider"></span></label></div>`);
    $card.append(`<div class="rst-setting-row"><div><div class="rst-setting-label">Stat lookup tool (function calling)</div><div class="rst-setting-sub">Lets the main LLM request a character's stats on demand — even when they aren't present. Requires a Chat Completion backend with tool calling enabled.</div></div><label class="rst-toggle"><input type="checkbox" id="rst-stat-tool" ${inj.statToolEnabled !== false ? "checked" : ""}><span class="rst-slider"></span></label></div>`);
    $card.append(`<div class="rst-setting-row"><div><div class="rst-setting-label">Library reference depth</div><div class="rst-setting-sub">Where in the context the library block is inserted (higher = later in context)</div></div><select id="rst-ref-depth" style="width:160px;flex-shrink:0"><option value="0"${(inj.libraryRefDepth === 0) ? " selected" : ""}>Top of prompt</option><option value="1"${(inj.libraryRefDepth === 1 || inj.libraryRefDepth === undefined) ? " selected" : ""}>Above character card</option><option value="2"${(inj.libraryRefDepth === 2) ? " selected" : ""}>Below character card</option></select></div>`);
    $card.append(`<div class="rst-setting-row"><div><div class="rst-setting-label">Library reference role</div><div class="rst-setting-sub">Speaker role for the injected library block</div></div><select id="rst-ref-role" style="width:160px;flex-shrink:0">${roleOptions}</select></div>`);

    $pane.append($card);

    $("#rst-inject-stats").on("change", async function () { saveSetting("injection.injectStats", $(this).prop("checked")); const { updateInjection } = await import("../inject/promptInjector.js"); updateInjection(); });
    $("#rst-inject-profile").on("change", async function () { saveSetting("injection.injectProfile", $(this).prop("checked")); const { updateInjection } = await import("../inject/promptInjector.js"); updateInjection(); });
    $("#rst-inject-format").on("change", async function () { saveSetting("injection.format", $(this).val()); const { updateInjection } = await import("../inject/promptInjector.js"); updateInjection(); });
    $("#rst-inject-placement").on("change", async function () { saveSetting("injection.placement", $(this).val()); const { updateInjection } = await import("../inject/promptInjector.js"); updateInjection(); });
    $("#rst-passive-ref").on("change", async function () { saveSetting("injection.passiveLibraryRef", $(this).prop("checked")); const { updateInjection } = await import("../inject/promptInjector.js"); updateInjection(); });
    $("#rst-stat-tool").on("change", function () { saveSetting("injection.statToolEnabled", $(this).prop("checked")); });
    $("#rst-ref-depth").on("change", async function () { saveSetting("injection.libraryRefDepth", parseInt($(this).val(), 10)); const { updateInjection } = await import("../inject/promptInjector.js"); updateInjection(); });
    $("#rst-ref-role").on("change", async function () { saveSetting("injection.libraryRefRole", $(this).val()); const { updatePassiveLibraryRef } = await import("../inject/promptInjector.js"); updatePassiveLibraryRef(); });
}

// ─── Data Section ─────────────────────────────────────────

function renderDataSection($pane) {
    const $btnRow = $(`<div class="rst-btn-row"><button class="rst-btn" id="rst-import-all">Import all</button><button class="rst-btn" id="rst-export-all">Export all</button></div>`);

    $btnRow.find("#rst-export-all").on("click", async () => {
        const data = await exportAllData();
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
            const file = e.target.files[0]; if (!file) return;
            const text = await file.text();
            const success = await importAllData(text);
            if (success) { toastr?.success?.("Data imported successfully."); renderSettingsTab($pane); }
            else { toastr?.error?.("Failed to import data."); }
        };
        input.click();
    });

    $pane.append($btnRow);
}
