/**
 * settings.js — Settings tab: all config UI
 * Renders the Settings tab with connection profiles, scan settings, injection settings, etc.
 */

import { getSettings, saveSetting } from "../data/storage.js";
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
    const $card = $(`
        <div class="rst-card">
            <div style="font-size:12px;color:var(--rst-text-muted);margin-bottom:10px;line-height:1.5">
                Scan existing or long chats to auto-detect scenes and characters. Creates blank character profiles,
                scene summaries, and an initial stat block per character. Runs once — does not compound on existing data.
            </div>
            <button class="rst-btn" style="border-color:var(--rst-accent);color:var(--rst-avatar-text)" id="rst-batch-scan">Run batch scan</button>
            <div id="rst-batch-progress" style="display:none;margin-top:8px;font-size:12px;color:var(--rst-text-muted)"></div>

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
            <div class="rst-setting-row">
                <div>
                    <div class="rst-setting-label">Chunk size (messages)</div>
                    <div class="rst-setting-sub">Messages per chunk when scanning long chats. Larger chunks may hit token limits.</div>
                </div>
                <input type="number" min="20" max="500" step="10"
                    value="${bs.chunkSize ?? 100}"
                    id="rst-bs-chunk-size" style="width:100px;flex-shrink:0">
            </div>
        </div>
    `);

    $card.find("#rst-batch-scan").on("click", async function () {
        const $btn = $(this);
        const $progress = $card.find("#rst-batch-progress");

        $btn.prop("disabled", true);
        $btn.text("Scanning...");
        $progress.show().text("Analyzing chat history for scene boundaries...");

        try {
            const { runBatchScan } = await import("../llm/batchScan.js");
            const result = await runBatchScan();

            if (result.scenesCreated > 0 || result.profilesCreated.length > 0) {
                $progress.text(`Done! ${result.scenesCreated} scenes created, ${result.profilesCreated.length} new profiles. Refreshing UI...`);

                // Re-render tabs to show new data
                const { renderHomeTab } = await import("./home.js");
                const { renderLibraryTab } = await import("./library.js");
                const { renderScenesTab } = await import("./scenes.js");
                const { getPane } = await import("./panel.js");

                renderHomeTab(getPane("home"));
                renderLibraryTab(getPane("lib"));
                renderScenesTab(getPane("scenes"));
            } else {
                $progress.text("No new scenes or profiles were created.");
            }
        } catch (err) {
            console.error("[RST] Batch scan failed:", err);
            $progress.text("Batch scan failed. Check console for details.");
            toastr?.error?.("Batch scan failed. See console for details.");
        } finally {
            $btn.prop("disabled", false);
            $btn.text("Run batch scan");
        }
    });

    // Batch scan settings listeners
    $card.find("#rst-bs-scene-tokens").on("change", async function () {
        saveSetting("batchScan.sceneDetectionMaxTokens", parseInt($(this).val(), 10));
    });
    $card.find("#rst-bs-stat-tokens").on("change", async function () {
        saveSetting("batchScan.initialStatMaxTokens", parseInt($(this).val(), 10));
    });
    $card.find("#rst-bs-chunk-size").on("change", async function () {
        saveSetting("batchScan.chunkSize", parseInt($(this).val(), 10));
    });

    $pane.append($card);
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

    $pane.append($card);

    // Listeners
    $("#rst-scan-freq").on("change", function () {
        saveSetting("scanFrequency", parseInt($(this).val(), 10));
    });

    $("#rst-new-char-popup").on("change", function () {
        saveSetting("newCharPopup", $(this).prop("checked"));
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
                <div class="rst-setting-sub">Inject library as freely-referenceable context — LLM can reference any tracked character's full relationship data when relevant (like timeline chapters)</div>
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
