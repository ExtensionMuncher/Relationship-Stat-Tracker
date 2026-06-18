/* eslint-disable */
// =============================================================================
// RST Debug Logging — lib/debug.js
// =============================================================================
// dlog() writes to the browser (F12) console ONLY when the "Debug F12 logging"
// toggle in Settings is turned on. This mirrors the pattern Memory Loom uses.
//
// The goal: keep the console quiet during normal use, but let you flip one
// switch to see the full sidecar → stat-update → injection pipeline when
// something needs investigating.
//
// IMPORTANT: warnings (console.warn) and errors (console.error) are intentionally
// NOT routed through here. Real problems should ALWAYS be visible regardless of
// the debug toggle. Only routine informational chatter is gated.
//
// This module reads the setting directly from SillyTavern's extension_settings
// rather than importing settings.js, so it has zero internal dependencies and
// can be imported by any file without risk of a circular import.
// =============================================================================

const NAMESPACE = 'rst';

/**
 * Logs to the console only when debug mode is enabled in settings.
 * Drop-in replacement for routine console.log calls.
 * @param {...any} args - Anything you'd normally pass to console.log.
 */
export function dlog(...args) {
    try {
        const ctx = SillyTavern.getContext();
        if (ctx?.extensionSettings?.[NAMESPACE]?.settings?.debug) {
            console.log('%c[RST]', 'color:#7F77DD;font-weight:bold', ...args);
        }
    } catch (_) {
        // If context isn't ready yet, stay silent — never throw from a logger.
    }
}
