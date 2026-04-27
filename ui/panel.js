/**
 * panel.js — Builds/manages the 4-tab extension panel
 * Creates the main RST panel and appends it to ST's extension settings area
 */

import { isEnabled, toggleEnabled, setSetting, getSetting } from "../settings.js";

// ─── Tab Definitions ──────────────────────────────────────

const TABS = [
    { id: "home", label: "Home" },
    { id: "lib", label: "Character library" },
    { id: "scenes", label: "Scenes" },
    { id: "settings", label: "Settings" },
];

// ─── Panel Creation ───────────────────────────────────────

/**
 * Create the main RST panel and append it to ST's extension settings.
 * @returns {jQuery} The panel element
 */
export function createPanel() {
    const $panel = $('<div class="rst-shell"></div>');

    // Tabs
    const $tabs = $('<div class="rst-tabs"></div>');
    TABS.forEach((tab, i) => {
        const $tab = $(`<div class="rst-tab${i === 0 ? " on" : ""}">${tab.label}</div>`);
        $tab.on("click", () => switchTab(tab.id));
        $tabs.append($tab);
    });
    $panel.append($tabs);

    // Panes
    TABS.forEach((tab, i) => {
        const $pane = $(`<div id="rst-p-${tab.id}" class="rst-pane${i === 0 ? " on" : ""}"></div>`);
        $panel.append($pane);
    });

    // Append to ST's extension settings area
    $("#extensions_settings").append($panel);

    return $panel;
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
 * @param {jQuery} $pane
 */
export function renderHomeHeader($pane) {
    const enabled = isEnabled();
    const statusText = enabled ? "Extension enabled" : "Extension disabled";

    const $header = $(`
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
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

    $pane.append($header);
    $pane.append('<hr class="rst-div">');
}
