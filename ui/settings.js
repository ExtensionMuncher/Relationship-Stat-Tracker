/**
 * settings.js — Settings tab: all config UI
 * Renders the Settings tab with connection profiles, scan settings, injection settings, etc.
 */

import { getSettings, saveSetting, getNameBlacklist, saveNameBlacklist } from "../data/storage.js";
import { setSetting, isEnabled, exportAllData, importAllData } from "../settings.js";
import { ConnectionManagerRequestService } from "../../../../extensions/shared.js";

// ─── Main Render ──────────────────────────────────────────

/**
 * Render the full Settings tab.
 * @param {jQuery} $pane
 */
export function renderSettingsTab($pane) {
    $pane.empty();
    const settings = getSettings();

    renderConnectionProfiles($pane, settings);
    renderBatchScan($pane);
    renderSceneSummaryPrompt($pane, settings);
    renderStatSettings($pane, settings);
    renderDetectionSettings($pane, settings);
    renderInjectionSettings($pane, settings);
    renderDataSection($pane);
}

// ─── Connection Profiles ──────────────────────────────────

/**
 * Render the connection profiles section using ST's ConnectionManagerRequestService.handleDropdown.
 * Each profile selector is a native ST dropdown grouped by API type.
 * @param {jQuery} $pane
 * @param {object} settings
 */
function renderConnectionProfiles($pane, settings) {
    $pane.append('<div class="rst-lbl">Connection profiles</div>');
    const $card = $('<div class="rst-card"></div>');

    // Two-column layout for stat update and sidecar
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

    // Auto-gen profile LLM (full width)
    const $autoGen = $(`
        <div>
            <div style="font-size:12px;color:var(--rst-text-muted);margin-bottom:4px">Auto-gen profile LLM</div>
            <select id="rst-conn-autogen" style="width:55%"></select>
        </div>
    `);

    $card.append($twoCol);
    $card.append($autoGen);
    $pane.append($card);

    // Initialize ST-native dropdowns (replaces manual <option> building)
    // These must be called after elements are in the DOM
    try {
        ConnectionManagerRequestService.handleDropdown(
            "#rst-conn-stat",
            settings.connections?.statUpdateLLM || "",
            (profile) => { saveSetting("connections.statUpdateLLM", profile?.id || ""); },
        );
    } catch (err) {
        console.warn("[RST] Connection Manager not available for stat update LLM:", err);
    }

    try {
        ConnectionManagerRequestService.handleDropdown(
            "#rst-conn-sidecar",
            settings.connections?.sidecarLLM || "",
            (profile) => { saveSetting("connections.sidecarLLM", profile?.id || ""); },
        );
    } catch (err) {
        console.warn("[RST] Connection Manager not available for sidecar LLM:", err);
    }

    try {
        ConnectionManagerRequestService.handleDropdown(
            "#rst-conn-autogen",
            settings.connections?.autoGenLLM || "",
            (profile) => { saveSetting("connections.autoGenLLM", profile?.id || ""); },
        );
    } catch (err) {
        console.warn("[RST] Connection Manager not available for auto-gen LLM:", err);
    }
}

// ─── Batch Scan ───────────────────────────────────────────

/**
 * Render the batch scan section.
 * @param {jQuery} $pane
 */
function renderBatchScan($pane) {
    const settings = getSettings();
    const bs = settings.batchScan || {};

    $pane.append('<div class="rst-lbl">Batch scan</div>');

    // ─── Main Batch Scan Card (description + run button + progress bar + token settings) ───
    const $card = $(`
        <div class="rst-card">
            <div style="font-size:12px;color:var(--rst-text-muted);margin-bottom:10px;line-height:1.5">
                Scan existing or long chats to auto-detect scenes and characters. Creates blank character profiles,
                scene summaries, and an initial stat block per character. Runs once — does not compound on existing data.
            </div>
            <button class="rst-btn" style="border-color:var(--rst-accent);color:var(--rst-avatar-text)" id="rst-batch-scan">Run batch scan</button>

            <!-- Progress bar (hidden until scan starts) -->
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

    // ─── Rate Limiting Card ──────────────────────────────────
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

    // ─── Advanced Throttling Card ────────────────────────────
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

    // ─── Click handler with progress bar wiring ───────────────
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

        // Reset progress display
        $fill.css("width", "0%");
        $phase.text("Phase 1/4: Initializing...");
        $detail.text("Starting batch scan...");
        $stats.text("Elapsed: 0s | API calls: 0/0");

        // Wire up progress callback and apply rate limiter settings
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

            // Clear the progress callback after completion
            setProgressCallback(null);

            if (result.scenesCreated > 0 || result.profilesCreated.length > 0) {
                $fill.css("width", "100%");
                $phase.text("Phase 4/4: Complete");
                $detail.text(`Done! ${result.scenesCreated} scenes created, ${result.profilesCreated.length} new profiles.`);
                $stats.text("Refreshing UI...");

                // Re-render tabs to show new data
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
            // Re-add scene buttons to all messages in case scenes were partially created
            // before an error occurred, which would have triggered ST re-render and destroyed buttons
            $(document).trigger("rst:refresh-message-buttons");

            $btn.prop("disabled", false);
            $btn.text("Run batch scan");
        }
    });

    // ─── Settings change listeners ────────────────────────────
    $card.find("#rst-bs-scene-tokens").on("change", async function () {
        saveSetting("batchScan.sceneDetectionMaxTokens", parseInt($(this).val(), 10));
    });
    $card.find("#rst-bs-stat-tokens").on("change", async function () {
        saveSetting("batchScan.initialStatMaxTokens", parseInt($(this).val(), 10));
    });
    $rateCard.find("#rst-bs-rpm").on("change", async function () {
        saveSetting("batchScan.requestsPerMinute", parseInt($(this).val(), 10));
        // Also update the rate limiter in real-time
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

/**
 * Render the scene summary prompt editor.
 * @param {jQuery} $pane
 * @param {object} settings
 */
function renderSceneSummaryPrompt($pane, settings) {
    $pane.append('<div class="rst-lbl">Scene summary prompt</div>');
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
        a.download = "rst-summary-prompt.txt";
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

/**
 * Render the stat change range settings.
 * @param {jQuery} $pane
 * @param {object} settings
 */
function renderStatSettings($pane, settings) {
    const range = settings.statChangeRange || { min: -5, max: 5 };

    $pane.append('<div class="rst-lbl">Stat settings</div>');
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
        </div>
    `);

    $card.find("#rst-range-min").on("change", function () {
        saveSetting("statChangeRange.min", parseInt($(this).val(), 10));
    });

    $card.find("#rst-range-max").on("change", function () {
        saveSetting("statChangeRange.max", parseInt($(this).val(), 10));
    });

    $pane.append($card);
}

// ─── Detection Settings ───────────────────────────────────

/**
 * Render detection settings (scan frequency, new char popup).
 * @param {jQuery} $pane
 * @param {object} settings
 */
function renderDetectionSettings($pane, settings) {
    $pane.append('<div class="rst-lbl">Detection settings</div>');
    const $card = $('<div class="rst-card"></div>');

    // Scan frequency
    const freqOptions = [3, 5, 7, 10].map((n) =>
        `<option value="${n}"${n === (settings.scanFrequency || 5) ? " selected" : ""}>${n}</option>`
    ).join("");

    $card.append(`
        <div class="rst-setting-row">
            <div>
                <div class="rst-setting-label">Scan frequency</div>
                <div class="rst-setting-sub">How often the sidecar LLM checks for character presence</div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
                <select id="rst-scan-freq" style="width:60px">${freqOptions}</select>
                <span style="font-size:12px;color:var(--rst-text-muted)">msgs</span>
            </div>
        </div>
    `);

    // New character popup
    $card.append(`
        <div class="rst-setting-row">
            <div>
                <div class="rst-setting-label">New character popup</div>
                <div class="rst-setting-sub">Prompt for approval when an unknown character is detected</div>
            </div>
            <label class="rst-toggle">
                <input type="checkbox" id="rst-new-char-popup" ${settings.newCharPopup !== false ? "checked" : ""}>
                <span class="rst-slider"></span>
            </label>
        </div>
    `);

    // Name blacklist (per-chat)
    const blacklistStr = (getNameBlacklist() || []).join(", ");
    $card.append(`
        <div class="rst-setting-row" style="border-bottom:none">
            <div>
                <div class="rst-setting-label">Name blacklist</div>
                <div class="rst-setting-sub">Names to always exclude from sidecar detection (comma-separated). Also excludes your ST user persona name automatically.</div>
            </div>
        </div>
        <div style="padding:0 0 4px">
            <textarea id="rst-name-blacklist" rows="2" style="width:100%;font-size:12px"
                placeholder="e.g. Narrator, Guide, System">${blacklistStr}</textarea>
        </div>
    `);

    $pane.append($card);

    // Listeners
    $("#rst-scan-freq").on("change", function () {
        saveSetting("scanFrequency", parseInt($(this).val(), 10));
    });

    $("#rst-new-char-popup").on("change", function () {
        saveSetting("newCharPopup", $(this).prop("checked"));
    });

    $("#rst-name-blacklist").on("change", function () {
        const raw = $(this).val();
        const list = raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        saveNameBlacklist(list);
    });
}

// ─── Injection Settings ───────────────────────────────────

/**
 * Render injection settings.
 * @param {jQuery} $pane
 * @param {object} settings
 */
function renderInjectionSettings($pane, settings) {
    const inj = settings.injection || {};

    $pane.append('<div class="rst-lbl">Injection settings</div>');
    const $card = $('<div class="rst-card"></div>');

    // Inject stat block
    $card.append(`
        <div class="rst-setting-row">
            <div>
                <div class="rst-setting-label">Inject stat block</div>
                <div class="rst-setting-sub">Inject character stats into system prompt when present in context</div>
            </div>
            <label class="rst-toggle">
                <input type="checkbox" id="rst-inject-stats" ${inj.injectStats !== false ? "checked" : ""}>
                <span class="rst-slider"></span>
            </label>
        </div>
    `);

    // Inject character profile
    $card.append(`
        <div class="rst-setting-row">
            <div>
                <div class="rst-setting-label">Inject character profile</div>
                <div class="rst-setting-sub">Also inject name, description, and notes — uses more tokens</div>
            </div>
            <label class="rst-toggle">
                <input type="checkbox" id="rst-inject-profile" ${inj.injectProfile !== false ? "checked" : ""}>
                <span class="rst-slider"></span>
            </label>
        </div>
    `);

    // Injection format
    const formatOptions = [
        { value: "stats_only", label: "Stats only" },
        { value: "stats_and_narrative", label: "Stats + narrative" },
    ].map((o) => `<option value="${o.value}"${o.value === (inj.format || "stats_and_narrative") ? " selected" : ""}>${o.label}</option>`).join("");

    $card.append(`
        <div class="rst-setting-row">
            <div>
                <div class="rst-setting-label">Injection format</div>
                <div class="rst-setting-sub">What gets included in the injected block</div>
            </div>
            <select id="rst-inject-format" style="width:160px;flex-shrink:0">${formatOptions}</select>
        </div>
    `);

    // Injection placement — 3 ST-standard positions only
    const placementOptions = [
        { value: "top", label: "Top of system prompt" },
        { value: "above_card", label: "Above character card" },
        { value: "below_card", label: "Below character card" },
    ].map((o) => `<option value="${o.value}"${o.value === (inj.placement || "above_card") ? " selected" : ""}>${o.label}</option>`).join("");

    $card.append(`
        <div class="rst-setting-row">
            <div>
                <div class="rst-setting-label">Injection placement</div>
                <div class="rst-setting-sub">Where in the system prompt the block is inserted</div>
            </div>
            <select id="rst-inject-placement" style="width:160px;flex-shrink:0">${placementOptions}</select>
        </div>
    `);

    // Passive library reference
    const roleOptions = [
        { value: "system", label: "System" },
        { value: "user", label: "User" },
        { value: "assistant", label: "Assistant" },
    ].map((o) => `<option value="${o.value}"${(o.value === (inj.libraryRefRole || "system")) ? " selected" : ""}>${o.label}</option>`).join("");

    $card.append(`
        <div class="rst-setting-row" style="border-top:1px solid var(--rst-border);padding-top:12px;margin-top:4px">
            <div>
                <div class="rst-setting-label">Passive library reference</div>
                <div class="rst-setting-sub">Inject library as freely-referenceable context — LLM can reference any tracked character's full relationship data when relevant</div>
            </div>
            <label class="rst-toggle">
                <input type="checkbox" id="rst-passive-ref" ${inj.passiveLibraryRef ? "checked" : ""}>
                <span class="rst-slider"></span>
            </label>
        </div>
        <div class="rst-setting-row">
            <div>
                <div class="rst-setting-label">Library reference depth</div>
                <div class="rst-setting-sub">Where in the context the library block is inserted (higher = later in context)</div>
            </div>
            <select id="rst-ref-depth" style="width:160px;flex-shrink:0">
                <option value="0"${(inj.libraryRefDepth === 0) ? " selected" : ""}>Top of prompt</option>
                <option value="1"${(inj.libraryRefDepth === 1 || inj.libraryRefDepth === undefined) ? " selected" : ""}>Above character card</option>
                <option value="2"${(inj.libraryRefDepth === 2) ? " selected" : ""}>Below character card</option>
            </select>
        </div>
        <div class="rst-setting-row">
            <div>
                <div class="rst-setting-label">Library reference role</div>
                <div class="rst-setting-sub">Speaker role for the injected library block</div>
            </div>
            <select id="rst-ref-role" style="width:160px;flex-shrink:0">${roleOptions}</select>
        </div>
    `);

    $pane.append($card);

    // Listeners
    $("#rst-inject-stats").on("change", async function () {
        saveSetting("injection.injectStats", $(this).prop("checked"));
        const { updateInjection } = await import("../inject/promptInjector.js");
        updateInjection();
    });

    $("#rst-inject-profile").on("change", async function () {
        saveSetting("injection.injectProfile", $(this).prop("checked"));
        const { updateInjection } = await import("../inject/promptInjector.js");
        updateInjection();
    });

    $("#rst-inject-format").on("change", async function () {
        saveSetting("injection.format", $(this).val());
        const { updateInjection } = await import("../inject/promptInjector.js");
        updateInjection();
    });

    $("#rst-inject-placement").on("change", async function () {
        saveSetting("injection.placement", $(this).val());
        const { updateInjection } = await import("../inject/promptInjector.js");
        updateInjection();
    });

    $("#rst-passive-ref").on("change", async function () {
        saveSetting("injection.passiveLibraryRef", $(this).prop("checked"));
        const { updateInjection } = await import("../inject/promptInjector.js");
        updateInjection();
    });

    $("#rst-ref-depth").on("change", async function () {
        saveSetting("injection.libraryRefDepth", parseInt($(this).val(), 10));
        const { updateInjection } = await import("../inject/promptInjector.js");
        updateInjection();
    });

    $("#rst-ref-role").on("change", async function () {
        saveSetting("injection.libraryRefRole", $(this).val());
        const { updatePassiveLibraryRef } = await import("../inject/promptInjector.js");
        updatePassiveLibraryRef();
    });
}

// ─── Data Section ─────────────────────────────────────────

/**
 * Render the data import/export section.
 * @param {jQuery} $pane
 */
function renderDataSection($pane) {
    $pane.append('<div class="rst-lbl">Data</div>');
    const $btnRow = $(`
        <div class="rst-btn-row">
            <button class="rst-btn" id="rst-import-all">Import all</button>
            <button class="rst-btn" id="rst-export-all">Export all</button>
        </div>
    `);

    $btnRow.find("#rst-export-all").on("click", async () => {
        const data = await exportAllData();
        const blob = new Blob([data], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "rst-data.json";
        a.click();
        URL.revokeObjectURL(url);
        toastr?.success?.("All data exported.");
    });

    $btnRow.find("#rst-import-all").on("click", () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json";
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const text = await file.text();
            const success = await importAllData(text);
            if (success) {
                toastr?.success?.("Data imported successfully.");
                renderSettingsTab($pane);
            } else {
                toastr?.error?.("Failed to import data.");
            }
        };
        input.click();
    });

    $pane.append($btnRow);
}
