/**
 * connections.js — Pull connection profiles from ST
 * Provides access to ST's connection manager profiles for LLM calls
 */

// ─── Connection Profile Access ────────────────────────────

/**
 * Get the SillyTavern context object.
 * @returns {object}
 */
function getSTContext() {
    return typeof getContext === "function" ? getContext() : null;
}

/**
 * Get all available connection profile names from ST.
 * @returns {Array<{name: string, id: string}>}
 */
export function getConnectionProfiles() {
    const ctx = getSTContext();
    if (!ctx) return [];

    // Connection Manager stores profiles in extensionSettings
    const cm = ctx.extensionSettings?.connectionManager;
    if (!cm || !cm.profiles) return [];

    return cm.profiles.map((p) => ({
        name: p.name || "Unnamed",
        id: p.id || p.name,
    }));
}

/**
 * Get a specific connection profile by name.
 * @param {string} profileName
 * @returns {object|null}
 */
export function getConnectionProfile(profileName) {
    if (!profileName) return null;

    const ctx = getSTContext();
    if (!ctx) return null;

    const cm = ctx.extensionSettings?.connectionManager;
    if (!cm || !cm.profiles) return null;

    return cm.profiles.find((p) => p.name === profileName) || null;
}

/**
 * Switch ST to use a specific connection profile.
 * @param {string} profileName
 * @returns {boolean} True if switched successfully
 */
export async function switchToProfile(profileName) {
    if (!profileName) return false;

    const profile = getConnectionProfile(profileName);
    if (!profile) {
        console.warn(`[RST] Connection profile "${profileName}" not found`);
        return false;
    }

    const ctx = getSTContext();
    if (!ctx) return false;

    try {
        // Apply the profile settings to ST's main connection
        const cm = ctx.extensionSettings?.connectionManager;
        if (cm && typeof cm.applyProfile === "function") {
            await cm.applyProfile(profile.id || profile.name);
            return true;
        }

        // Fallback: directly set the active profile
        if (cm) {
            cm.activeProfile = profile.id || profile.name;
            return true;
        }

        return false;
    } catch (err) {
        console.error("[RST] Failed to switch connection profile:", err);
        return false;
    }
}

/**
 * Get the currently active connection profile name.
 * @returns {string}
 */
export function getActiveProfileName() {
    const ctx = getSTContext();
    if (!ctx) return "";

    const cm = ctx.extensionSettings?.connectionManager;
    if (!cm) return "";

    // Try to find the active profile
    if (cm.activeProfile) {
        const profile = cm.profiles?.find(
            (p) => p.id === cm.activeProfile || p.name === cm.activeProfile
        );
        return profile ? profile.name : cm.activeProfile;
    }

    return "Default";
}

/**
 * Save the current connection state and switch to a specific profile.
 * Returns a restore function that switches back.
 * @param {string} profileName
 * @returns {Promise<{restore: Function}>}
 */
export async function withProfile(profileName) {
    const previousProfile = getActiveProfileName();

    if (profileName && profileName !== previousProfile) {
        await switchToProfile(profileName);
    }

    return {
        restore: async () => {
            if (profileName && profileName !== previousProfile) {
                await switchToProfile(previousProfile);
            }
        },
    };
}
