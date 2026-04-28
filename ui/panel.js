/**
 * panel.js — Builds/manages the 4-tab extension panel
 * Creates the main RST panel using ST's extension_container + inline-drawer pattern
 * and appends it to ST's extension settings area
 */

import { isEnabled, toggleEnabled } from "../settings.js";

// ─── Tab Definitions ──────────────────────────────────────

const TABS = [
    { id: "home", label: "Home" },
    { id: "lib", label: "Character library" },
    { id: "scenes", label: "Scenes" },
    { id: "settings", label: "Settings" },
];

// ─── Panel Creation ───────────────────────────────────────

/**
 * Create the main RST panel using ST's extension_container + inline-drawer pattern.
 * @returns {jQuery} The panel element
 */
export function createPanel() {
    // ST's extension_container + inline-drawer pattern
    const $container = $(`
        <div id="rst_container" class="extension_container">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Relationship State Tracker</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="rst-shell"></div>
                </div>
            </div>
            <!-- Persistent loading overlay (non-blocking banner, survives tab switches) -->
            <div id="rst-loading-overlay" class="rst-loading-overlay" style="display:none">
                <div class="rst-loading-content">
                    <i class="fa-solid fa-spinner fa-spin" style="font-size:13px;color:var(--rst-accent)"></i>
                    <div id="rst-loading-text" style="margin-top:0;font-size:11px;color:var(--rst-text)">Processing...</div>
                </div>
            </div>
        </div>
    `);

    const $shell = $container.find(".rst-shell");

    // Tabs
    const $tabs = $('<div class="rst-tabs"></div>');
    TABS.forEach((tab, i) => {
        const $tab = $(`<div class="rst-tab${i === 0 ? " on" : ""}">${tab.label}</div>`);
        $tab.on("click", () => switchTab(tab.id));
        $tabs.append($tab);
    });
    $shell.append($tabs);

    // Panes
    TABS.forEach((tab, i) => {
        const $pane = $(`<div id="rst-p-${tab.id}" class="rst-pane${i === 0 ? " on" : ""}"></div>`);
        $shell.append($pane);
    });

    // Append to ST's extension settings area
    $("#extensions_settings").append($container);

    return $shell;
}

// ─── Loading Indicator ────────────────────────────────────

let loadingTimeout = null;

/**
 * Show a persistent loading overlay on the RST panel.
 * The overlay survives tab switches and auto-hides after a timeout.
 * @param {string} [message="Processing..."] - Status message to display
 */
export function showPanelLoading(message = "Processing...") {
    clearTimeout(loadingTimeout);
    const $overlay = $("#rst-loading-overlay");
    if ($overlay.length) {
        $("#rst-loading-text").text(message);
        $overlay.fadeIn(150);
    }
}

/**
 * Hide the persistent loading overlay.
 */
export function hidePanelLoading() {
    clearTimeout(loadingTimeout);
    const $overlay = $("#rst-loading-overlay");
    if ($overlay.length) {
        $overlay.fadeOut(150);
    }
}

/**
 * Switch to a specific tab.
 * @param {string} tabId - Tab identifier (home, lib, scenes, settings)
 */
export function switchTab(tabId) {
    // Update tab buttons
    $(".rst-tab").removeClass("on");
    const tabIndex = TABS.findIndex((t) => t.id === tabId);
    if (tabIndex >= 0) {
        $(".rst-tab").eq(tabIndex).addClass("on");
    }

    // Update panes
    $(".rst-pane").removeClass("on");
    $(`#rst-p-${tabId}`).addClass("on");

    // Trigger tab-specific refresh
    $(document).trigger("rst:tab-switched", [tabId]);
}

/**
 * Get the jQuery element for a specific tab's pane.
 * @param {string} tabId
 * @returns {jQuery}
 */
export function getPane(tabId) {
    return $(`#rst-p-${tabId}`);
}

/**
 * Get the currently active tab ID.
 * @returns {string}
 */
export function getActiveTab() {
    const $activeTab = $(".rst-tab.on");
    const index = $(".rst-tab").index($activeTab);
    return TABS[index]?.id || "home";
}

// ─── Home Tab Header ──────────────────────────────────────

/**
 * Render the Home tab header with enable toggle.
 * Replaces any existing header to avoid duplicates on re-render.
 * @param {jQuery} $pane
 */
export function renderHomeHeader($pane) {
    const enabled = isEnabled();
    const statusText = enabled ? "Extension enabled" : "Extension disabled";

    // Remove existing header to prevent duplicates
    $pane.find("#rst-header-wrap").remove();

    const $header = $(`
        <div id="rst-header-wrap" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
            <div>
                <div style="font-size:14px;font-weight:500">Relationship state tracker</div>
                <div id="rst-ext-lbl" style="font-size:11px;color:var(--rst-text-muted)">${statusText}</div>
            </div>
            <label class="rst-toggle">
                <input type="checkbox" ${enabled ? "checked" : ""}>
                <span class="rst-slider"></span>
            </label>
        </div>
    `);

    $header.find("input").on("change", function () {
        const newState = $(this).prop("checked");
        toggleEnabled(newState);
        $("#rst-ext-lbl").text(newState ? "Extension enabled" : "Extension disabled");
        $(document).trigger("rst:toggle", [newState]);
    });

    $pane.prepend($header);
    // Ensure divider follows the header
    const $divider = $pane.find("> hr.rst-div");
    if ($divider.length) {
        $divider.insertAfter($header);
    } else {
        $pane.find("#rst-header-wrap").after('<hr class="rst-div">');
    }
}
