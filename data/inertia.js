/**
 * inertia.js — deterministic, internal-only relationship hysteresis.
 *
 * RST inertia is a continuity guard, not a relationship-growth governor.
 * The stat-update LLM decides the direction and ordinary magnitude of change.
 * This module only resists a large, isolated reversal against an established
 * recent direction. It never slows same-direction growth, never couples stats,
 * never uses RNG, and never appears in prompts/UI/exports.
 *
 * Crucially, hysteresis is derived PER STAT. Character-wide trajectory labels
 * are intentionally irrelevant here: one volatile/hostile/romantic axis must
 * never disable continuity protection for an unrelated trust/support axis.
 *
 * Reversal resistance releases deterministically as the new direction persists:
 *   first ordinary reversal  -> strongest resistance
 *   second consecutive turn  -> lighter resistance
 *   third+ consecutive turn  -> no resistance
 * Repeated sign-flipping in the SAME stat is treated as locally volatile and
 * releases the guard for that stat only. A narratively pivotal critical
 * *candidate* gets the full ordinary range even if the separate critical-change
 * RNG does not fire; an actually-fired critical bypasses inertia entirely.
 */

import { dlog } from "../lib/debug.js";

const CATEGORIES = ["platonic", "romantic", "sexual"];
const STATS = ["trust", "openness", "support", "affection"];
const HISTORY_DEPTH = 6;
const BACKBONE_DEPTH = 4;
const MIN_BACKBONE = 2;
const DETERMINISM_CACHE_LIMIT = 256;
const processedStats = new WeakSet();
const determinismCache = new Map();

function isNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

function narrativeEntries(profile) {
    return (Array.isArray(profile?.updateLog) ? profile.updateLog : [])
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry && entry.source !== "manual_edit" && entry.statsBefore && entry.statsAfter)
        // Trusted hysteresis history must be tied to an actual narrative unit.
        // Older builds sometimes wrote scene-less LLM updates for characters who
        // were merely discussed (for example, a third party describing an absent
        // character). Those records remain visible history but cannot anchor
        // hidden inertia. Valid physical/remote/parallel updates retain sceneId
        // and/or messageRange provenance and therefore remain eligible.
        .filter(({ entry }) => {
            const hasScene = typeof entry.sceneId === "string" && entry.sceneId.trim().length > 0;
            const range = entry.messageRange;
            const hasRange = range && Number.isFinite(Number(range.start)) && Number.isFinite(Number(range.end));
            return hasScene || hasRange;
        })
        .sort((a, b) => {
            const aTime = Number(a.entry?.timestamp);
            const bTime = Number(b.entry?.timestamp);
            if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return bTime - aTime;
            return a.index - b.index;
        })
        .map(({ entry }) => entry);
}

function normalizeStatSet(values) {
    return new Set((Array.isArray(values) ? values : [])
        .filter((value) => typeof value === "string")
        .map((value) => value.toLowerCase().trim())
        .filter(Boolean));
}

function entryWasCritical(entry, key) {
    return normalizeStatSet(entry?.criticalStats).has(key);
}

function sign(value) {
    return value > 0 ? 1 : value < 0 ? -1 : 0;
}

function directionalLimit(delta, range) {
    if (delta > 0) return Math.max(0, Number.isFinite(Number(range?.max)) ? Number(range.max) : 5);
    if (delta < 0) return Math.max(0, Math.abs(Number.isFinite(Number(range?.min)) ? Number(range.min) : -5));
    return 0;
}

/**
 * Return only trustworthy, actually-applied narrative transitions.
 *
 * Legacy Batch Scan builds sometimes wrote independent absolute snapshots or
 * giant unguarded jumps. Those must not become hidden "momentum" merely because
 * they exist in an old export. A historical delta larger than the current
 * ordinary directional range is therefore ignored unless the update log records
 * that stat as an actually-fired critical change. This is intentionally
 * conservative: discarding ambiguous history can only reduce inertia; it cannot
 * manufacture resistance from corrupted legacy data.
 */
function recentTransitionHistory(profile, category, stat, range) {
    const key = `${category}.${stat}`;
    const deltas = [];
    const ignored = [];

    for (const entry of narrativeEntries(profile)) {
        const before = entry.statsBefore?.[category]?.[stat];
        const after = entry.statsAfter?.[category]?.[stat];
        if (!isNumber(before) || !isNumber(after)) continue;

        const delta = after - before;
        if (delta === 0) continue;

        const limit = directionalLimit(delta, range);
        const historicalCritical = entryWasCritical(entry, key);
        if (limit <= 0 || (Math.abs(delta) > limit && !historicalCritical)) {
            ignored.push({
                timestamp: Number.isFinite(Number(entry.timestamp)) ? Number(entry.timestamp) : null,
                source: entry.source || "unknown",
                delta,
                reason: historicalCritical ? "range_disabled" : "implausible_legacy_delta",
            });
            continue;
        }

        deltas.push(delta);
        if (deltas.length >= HISTORY_DEPTH) break;
    }

    return { deltas, ignored };
}

function visible(profile, category) {
    return profile?.statCategoryVisibility?.[category] !== false;
}

function cloneStats(stats) {
    if (typeof structuredClone === "function") return structuredClone(stats);
    return JSON.parse(JSON.stringify(stats));
}

function snapshotStats(stats) {
    const out = {};
    for (const category of CATEGORIES) {
        out[category] = {};
        for (const stat of STATS) out[category][stat] = stats?.[category]?.[stat];
    }
    return out;
}

function cacheDeterministicResult(signature, output) {
    const serialized = JSON.stringify(output);
    const prior = determinismCache.get(signature);
    if (prior !== undefined && prior !== serialized) {
        const error = new Error("[RST/Inertia] DETERMINISM VIOLATION: identical inertia inputs produced different outputs.");
        console.error(error, { signature, prior, current: serialized });
        throw error;
    }
    if (prior === undefined) {
        if (determinismCache.size >= DETERMINISM_CACHE_LIMIT) {
            const oldest = determinismCache.keys().next().value;
            determinismCache.delete(oldest);
        }
        determinismCache.set(signature, serialized);
    }
}

function assertAdjustmentInvariant(key, proposedDelta, adjustedDelta, firedCritical) {
    if (!isNumber(adjustedDelta)) {
        throw new Error(`[RST/Inertia] Invalid non-finite result for ${key}.`);
    }
    if (firedCritical && adjustedDelta !== proposedDelta) {
        throw new Error(`[RST/Inertia] Critical bypass invariant failed for ${key}.`);
    }
    if (proposedDelta === 0 && adjustedDelta !== 0) {
        throw new Error(`[RST/Inertia] Zero-change invariant failed for ${key}.`);
    }
    if (Math.abs(adjustedDelta) > Math.abs(proposedDelta)) {
        throw new Error(`[RST/Inertia] Inertia illegally boosted ${key}: ${proposedDelta} -> ${adjustedDelta}.`);
    }
    if (adjustedDelta !== 0 && proposedDelta !== 0 && sign(adjustedDelta) !== sign(proposedDelta)) {
        throw new Error(`[RST/Inertia] Inertia illegally reversed ${key}: ${proposedDelta} -> ${adjustedDelta}.`);
    }
}

function reversalBackbone(history, proposedSign) {
    if (!history.length || proposedSign === 0) {
        return { reversalStreak: 0, backboneDirection: 0, backboneCount: 0, opposingCount: 0, sameCount: 0 };
    }

    let reversalStreak = 0;
    for (const delta of history) {
        if (sign(delta) !== proposedSign) break;
        reversalStreak += 1;
    }

    // Once two approved updates have already persisted in the proposed direction,
    // the turn is established enough that inertia must stop resisting it.
    if (reversalStreak >= 2) {
        return { reversalStreak, backboneDirection: 0, backboneCount: 0, opposingCount: 0, sameCount: 0 };
    }

    const older = history.slice(reversalStreak, reversalStreak + BACKBONE_DEPTH);
    let opposingCount = 0;
    let sameCount = 0;
    for (const delta of older) {
        const s = sign(delta);
        if (s === -proposedSign) opposingCount += 1;
        else if (s === proposedSign) sameCount += 1;
    }

    // Require a real directional backbone, not one noisy prior update. At least
    // two older transitions must oppose the proposed direction, and they must
    // outnumber any same-direction transitions in the sampled backbone.
    const established = opposingCount >= MIN_BACKBONE && opposingCount > sameCount;
    return {
        reversalStreak,
        backboneDirection: established ? -proposedSign : 0,
        backboneCount: established ? opposingCount : 0,
        opposingCount,
        sameCount,
    };
}

function isLocallyVolatile(history) {
    const signs = history.map(sign).filter(Boolean).slice(0, HISTORY_DEPTH);
    if (signs.length < 4) return false;

    let positive = 0;
    let negative = 0;
    let flips = 0;
    for (let i = 0; i < signs.length; i++) {
        if (signs[i] > 0) positive += 1;
        else negative += 1;
        if (i > 0 && signs[i] !== signs[i - 1]) flips += 1;
    }

    // Require repeated bidirectional evidence, not one rupture followed by repair.
    // This identifies a genuinely oscillating STAT while keeping unrelated axes
    // completely isolated from one another.
    return positive >= 2 && negative >= 2 && flips >= 2;
}

function reversalCap(limit, reversalStreak) {
    if (limit <= 0) return 0;
    const ratio = reversalStreak >= 1 ? 0.75 : 0.40;
    return Math.min(limit, Math.max(1, Math.ceil(limit * ratio)));
}

/**
 * Apply deterministic relationship hysteresis after critical RNG has already
 * been resolved but before ordinary range/lock enforcement.
 *
 * @param {object} profile Character profile with approved updateLog history.
 * @param {object} statsBefore Current committed stats.
 * @param {object} proposedStats LLM-proposed absolute stats.
 * @param {string[]} firedCriticalStats Critical candidates that actually won RNG.
 * @param {{min:number,max:number}} range Configured ordinary per-update delta range.
 * @param {string[]} criticalCandidateStats LLM-declared pivotal stats, whether or not RNG fired.
 * @returns {{statsAfter: object}}
 */
export function applyRelationshipInertia(
    profile,
    statsBefore,
    proposedStats,
    firedCriticalStats = [],
    range = { min: -5, max: 5 },
    criticalCandidateStats = [],
) {
    const result = cloneStats(proposedStats);
    const firedSet = normalizeStatSet(firedCriticalStats);
    const candidateSet = normalizeStatSet(criticalCandidateStats);
    const configuredPositiveLimit = Math.max(0, Number.isFinite(Number(range?.max)) ? Number(range.max) : 5);
    const configuredNegativeLimit = Math.max(0, Math.abs(Number.isFinite(Number(range?.min)) ? Number(range.min) : -5));
    const historySnapshot = {};
    const ignoredHistorySnapshot = {};
    const evaluations = [];

    for (const category of CATEGORIES) {
        if (!visible(profile, category)) continue;
        for (const stat of STATS) {
            const key = `${category}.${stat}`;
            const before = statsBefore?.[category]?.[stat];
            const proposed = result?.[category]?.[stat];
            if (!isNumber(before) || !isNumber(proposed)) continue;

            const proposedDelta = proposed - before;
            const firedCritical = firedSet.has(key);
            const pivotalCandidate = candidateSet.has(key);
            const historyInfo = recentTransitionHistory(profile, category, stat, range);
            const history = historyInfo.deltas;
            const localVolatile = isLocallyVolatile(history);
            historySnapshot[key] = history;
            if (historyInfo.ignored.length) ignoredHistorySnapshot[key] = historyInfo.ignored;

            let allowedMagnitude = Math.abs(proposedDelta);
            let reason = "unchanged";
            let reversal = { reversalStreak: 0, backboneDirection: 0, backboneCount: 0, opposingCount: 0, sameCount: 0 };

            if (proposedDelta !== 0) {
                if (firedCritical) {
                    reason = "critical_bypass";
                } else if (pivotalCandidate) {
                    // The critical-change RNG controls access to the *wider* range.
                    // It must not randomly decide whether a genuine narrative pivot
                    // is allowed to use the normal configured range at all.
                    reason = "pivotal_candidate_release";
                } else if (localVolatile) {
                    reason = "local_stat_volatility_release";
                } else {
                    const proposedSign = sign(proposedDelta);
                    reversal = reversalBackbone(history, proposedSign);
                    if (reversal.backboneDirection === -proposedSign) {
                        const limit = proposedSign > 0 ? configuredPositiveLimit : configuredNegativeLimit;
                        const cap = reversalCap(limit, reversal.reversalStreak);
                        if (cap > 0 && Math.abs(proposedDelta) > cap) {
                            allowedMagnitude = cap;
                            reason = reversal.reversalStreak >= 1
                                ? "persisting_reversal_resistance"
                                : "isolated_reversal_resistance";
                        } else {
                            reason = "reversal_within_hysteresis";
                        }
                    } else {
                        // Same-direction acceleration and ordinary movement are
                        // intentionally left untouched. Narrative magnitude belongs
                        // to the stat-update model; inertia only guards discontinuity.
                        reason = "ordinary_or_same_direction";
                    }
                }
            }

            if (allowedMagnitude < Math.abs(proposedDelta)) {
                result[category][stat] = before + (sign(proposedDelta) * allowedMagnitude);
            }

            const adjustedDelta = result[category][stat] - before;
            assertAdjustmentInvariant(key, proposedDelta, adjustedDelta, firedCritical);
            if (proposedDelta !== 0) {
                evaluations.push({
                    stat: key,
                    before,
                    proposed,
                    proposedDelta,
                    final: result[category][stat],
                    adjustedDelta,
                    recentTrustedDeltas: history,
                    reversalStreak: reversal.reversalStreak,
                    backboneDirection: reversal.backboneDirection,
                    backboneCount: reversal.backboneCount,
                    localVolatile,
                    pivotalCandidate,
                    criticalBypass: firedCritical,
                    reason,
                });
            }
        }
    }

    processedStats.add(result);

    const signature = JSON.stringify({
        before: snapshotStats(statsBefore),
        proposed: snapshotStats(proposedStats),
        firedCriticals: [...firedSet].sort(),
        criticalCandidates: [...candidateSet].sort(),
        range: { min: configuredNegativeLimit ? -configuredNegativeLimit : 0, max: configuredPositiveLimit },
        visibility: Object.fromEntries(CATEGORIES.map((category) => [category, visible(profile, category)])),
        trustedHistory: historySnapshot,
        ignoredHistory: ignoredHistorySnapshot,
    });
    cacheDeterministicResult(signature, snapshotStats(result));

    if (evaluations.length) {
        dlog("[Inertia] deterministic hysteresis evaluation", {
            character: profile?.name || profile?.id || "unknown",
            range: { min: -configuredNegativeLimit, max: configuredPositiveLimit },
            evaluations,
            ignoredLegacyHistory: ignoredHistorySnapshot,
        });
    }

    return { statsAfter: result };
}

/**
 * Runtime guard used by the relationship update pipeline. The marker lives only
 * in a WeakSet, so it can never leak into pending cards, exports, prompts, or UI.
 */
export function assertRelationshipInertiaProcessed(stats, context = "relationship update") {
    if (stats && typeof stats === "object" && processedStats.has(stats)) return true;
    const error = new Error(`[RST/Inertia] PIPELINE BYPASS: ${context} reached range/lock enforcement without deterministic inertia.`);
    console.error(error);
    throw error;
}
