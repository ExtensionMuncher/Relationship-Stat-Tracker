/**
 * inertia.js — Conservative relationship inertia derived from approved history.
 * Inertia NEVER boosts stat movement. It only resists unjustified acceleration
 * or abrupt reversal when recent history is consistent.
 */

const CATEGORIES = ["platonic", "romantic", "sexual"];
const STATS = ["trust", "openness", "support", "affection"];
const HISTORY_DEPTH = 3;

function isNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

function narrativeEntries(profile) {
    return (Array.isArray(profile?.updateLog) ? profile.updateLog : [])
        .filter((entry) => entry && entry.source !== "manual_edit" && entry.statsBefore && entry.statsAfter)
        .filter((entry) => entry.sceneId || entry.messageRange || ["llm", "batch_scan", "stat_update"].includes(entry.source));
}

function recentDeltas(profile, category, stat) {
    const deltas = [];
    for (const entry of narrativeEntries(profile)) {
        const before = entry.statsBefore?.[category]?.[stat];
        const after = entry.statsAfter?.[category]?.[stat];
        if (!isNumber(before) || !isNumber(after)) continue;
        deltas.push(after - before);
        if (deltas.length >= HISTORY_DEPTH) break;
    }
    return deltas;
}

function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function sign(value) {
    return value > 0 ? 1 : value < 0 ? -1 : 0;
}

function visible(profile, category) {
    return profile?.statCategoryVisibility?.[category] !== false;
}

/**
 * Compact history for the LLM. No generated interpretation, just approved deltas.
 */
export function getRelationshipInertiaContext(profile) {
    const lines = [];
    for (const category of CATEGORIES) {
        if (!visible(profile, category)) continue;
        for (const stat of STATS) {
            const deltas = recentDeltas(profile, category, stat);
            const meaningful = deltas.filter((delta) => delta !== 0);
            if (!meaningful.length) continue;
            lines.push(`${category}.${stat}: ${deltas.map((delta) => `${delta > 0 ? "+" : ""}${delta}`).join(", ")} (newest first)`);
        }
    }
    return lines;
}

/**
 * Apply conservative inertia after critical RNG has been resolved but before
 * ordinary range/lock enforcement. Only ACTUALLY FIRED criticals bypass inertia.
 * Custom asymmetric stat ranges inform how much ordinary movement is plausible
 * in each direction; inertia still never boosts a proposal.
 * @returns {{statsAfter: object, adjustments: Array<object>}}
 */
export function applyRelationshipInertia(profile, statsBefore, proposedStats, firedCriticalStats = [], trajectoryLabel = "", range = { min: -5, max: 5 }) {
    const result = structuredClone(proposedStats);
    const adjustments = [];
    const criticalSet = new Set((Array.isArray(firedCriticalStats) ? firedCriticalStats : []).map((x) => String(x || "").toLowerCase().trim()));
    const flexibleReversal = trajectoryLabel === "Volatile" || trajectoryLabel === "Polarized";
    const configuredPositiveLimit = Math.max(0, Number.isFinite(Number(range?.max)) ? Number(range.max) : 5);
    const configuredNegativeLimit = Math.max(0, Math.abs(Number.isFinite(Number(range?.min)) ? Number(range.min) : -5));

    for (const category of CATEGORIES) {
        if (!visible(profile, category)) continue;
        for (const stat of STATS) {
            const key = `${category}.${stat}`;
            const before = statsBefore?.[category]?.[stat];
            const proposed = result?.[category]?.[stat];
            if (!isNumber(before) || !isNumber(proposed)) continue;

            const proposedDelta = proposed - before;
            if (proposedDelta === 0 || criticalSet.has(key)) continue;

            const history = recentDeltas(profile, category, stat);
            const meaningful = history.filter((delta) => delta !== 0);
            if (meaningful.length < 2) continue;

            const signs = meaningful.map(sign);
            const consistent = signs.every((value) => value === signs[0]);
            if (!consistent) continue;

            const priorSign = signs[0];
            const proposedSign = sign(proposedDelta);
            const priorMagnitude = median(meaningful.map((delta) => Math.abs(delta)));
            let allowedMagnitude = Math.abs(proposedDelta);
            let reason = "";

            const directionalLimit = proposedSign > 0 ? configuredPositiveLimit : configuredNegativeLimit;
            if (directionalLimit <= 0) continue;

            if (proposedSign === priorSign) {
                // Wider custom ranges get modest headroom, not proportional
                // acceleration. +10 adds ~1 point; -20 adds ~2 points over the
                // recent typical magnitude.
                const rangeHeadroom = Math.max(1, Math.round(directionalLimit * 0.10));
                const continuationCap = Math.min(
                    directionalLimit,
                    Math.max(2, Math.ceil(priorMagnitude) + rangeHeadroom),
                );
                if (Math.abs(proposedDelta) > continuationCap) {
                    allowedMagnitude = continuationCap;
                    reason = `same-direction acceleration limited by recent approved ${key} movement (${meaningful.join(", ")}) within configured ${proposedSign > 0 ? "+" : "-"}${directionalLimit} range`;
                }
            } else if (!flexibleReversal && proposedSign !== 0) {
                // Reversal resistance scales conservatively with the configured
                // directional ceiling. Asymmetric setups such as -20/+10 retain
                // more ordinary downside headroom than recovery headroom.
                const reversalCap = Math.min(
                    directionalLimit,
                    Math.max(2, Math.ceil(directionalLimit * 0.25), Math.ceil(priorMagnitude * 0.5)),
                );
                if (Math.abs(proposedDelta) > reversalCap) {
                    allowedMagnitude = reversalCap;
                    reason = `abrupt reversal limited against recent approved ${key} direction (${meaningful.join(", ")}) within configured ${proposedSign > 0 ? "+" : "-"}${directionalLimit} range`;
                }
            }

            if (allowedMagnitude < Math.abs(proposedDelta)) {
                const adjustedDelta = proposedSign * allowedMagnitude;
                result[category][stat] = before + adjustedDelta;
                adjustments.push({
                    stat: key,
                    proposedDelta,
                    adjustedDelta,
                    reason,
                    recentDeltas: meaningful,
                });
            }
        }
    }

    return { statsAfter: result, adjustments };
}
