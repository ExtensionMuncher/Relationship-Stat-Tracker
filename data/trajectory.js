/**
 * trajectory.js — Deterministic relationship trajectory derived from approved
 * character stat history. No LLM calls and no persisted trajectory state.
 *
 * RST is intentionally tolerant of sparse histories. Batch Scan stores full
 * scene checkpoints in statsAfter and older exports may not include statsBefore;
 * when that happens, adjacent narrative checkpoints are compared to recover the
 * movement that actually occurred between scans.
 */

const CATEGORIES = ["platonic", "romantic", "sexual"];
const STATS = ["trust", "openness", "support", "affection"];
const MAX_HISTORY = 5;
const EPSILON = 0.75;
const GRADUAL_THRESHOLD = 1.5;
const RAPID_THRESHOLD = 8;

function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

function categoryVisible(profile, category) {
    return profile?.statCategoryVisibility?.[category] !== false;
}

function isNarrativeUpdate(entry) {
    if (!entry || typeof entry !== "object") return false;
    if (entry.source === "manual_edit") return false;
    if (!entry.statsAfter || typeof entry.statsAfter !== "object") return false;

    // Narrative update paths carry a scene/message anchor or an explicit
    // scanner/LLM source. Free-standing manual corrections stay excluded so
    // editing a number does not fabricate relationship motion.
    return Boolean(
        entry.sceneId
        || entry.messageRange
        || entry.source === "llm"
        || entry.source === "llm_initial"
        || entry.source === "batch_scan"
        || entry.source === "stat_update"
    );
}

function sortNarrativeHistory(rawLog) {
    return rawLog
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => isNarrativeUpdate(entry))
        .sort((a, b) => {
            const aTime = Number(a.entry?.timestamp);
            const bTime = Number(b.entry?.timestamp);
            if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
                return bTime - aTime;
            }
            return a.index - b.index;
        })
        .map(({ entry }) => entry);
}

function hasComparableValues(stats, profile) {
    if (!stats || typeof stats !== "object") return false;
    for (const category of CATEGORIES) {
        if (!categoryVisible(profile, category)) continue;
        for (const stat of STATS) {
            if (isFiniteNumber(stats?.[category]?.[stat])) return true;
        }
    }
    return false;
}

function hasEstablishedStats(profile) {
    for (const category of CATEGORIES) {
        if (!categoryVisible(profile, category)) continue;
        for (const stat of STATS) {
            const value = profile?.stats?.[category]?.[stat];
            if (isFiniteNumber(value) && Math.abs(value) > EPSILON) return true;
        }
    }
    return false;
}

function summarizeMovement(before, after, profile) {
    const domains = {};
    let net = 0;
    let absolute = 0;
    let positive = 0;
    let negative = 0;
    let compared = 0;

    for (const category of CATEGORIES) {
        if (!categoryVisible(profile, category)) continue;
        let domainNet = 0;
        let domainAbsolute = 0;
        let domainCompared = 0;

        for (const stat of STATS) {
            const beforeValue = before?.[category]?.[stat];
            const afterValue = after?.[category]?.[stat];
            if (!isFiniteNumber(beforeValue) || !isFiniteNumber(afterValue)) continue;

            const delta = afterValue - beforeValue;
            domainNet += delta;
            domainAbsolute += Math.abs(delta);
            net += delta;
            absolute += Math.abs(delta);
            compared += 1;
            domainCompared += 1;
            if (delta > 0) positive += delta;
            if (delta < 0) negative += Math.abs(delta);
        }

        if (domainCompared > 0) {
            domains[category] = {
                net: domainNet,
                absolute: domainAbsolute,
                compared: domainCompared,
                averageNet: domainNet / domainCompared,
                averageAbsolute: domainAbsolute / domainCompared,
            };
        }
    }

    if (compared === 0) return null;

    return {
        net,
        absolute,
        positive,
        negative,
        compared,
        averageNet: net / compared,
        averageAbsolute: absolute / compared,
        domains,
    };
}

/**
 * Build comparable relationship transitions from newest-first narrative
 * checkpoints. Explicit statsBefore wins when present. If an older Batch Scan
 * (or legacy narrative update) omitted statsBefore, compare its statsAfter to
 * the next older checkpoint's statsAfter instead.
 */
function buildTransitions(profile, checkpoints) {
    const transitions = [];

    for (let index = 0; index < checkpoints.length; index++) {
        const current = checkpoints[index];
        const currentAfter = current?.statsAfter;
        if (!hasComparableValues(currentAfter, profile)) continue;

        let before = null;
        let inferred = false;

        if (hasComparableValues(current?.statsBefore, profile)) {
            before = current.statsBefore;
        } else {
            const older = checkpoints[index + 1];
            if (older && hasComparableValues(older?.statsAfter, profile)) {
                before = older.statsAfter;
                inferred = true;
            }
        }

        if (!before) continue;
        const summary = summarizeMovement(before, currentAfter, profile);
        if (!summary) continue;

        transitions.push({
            entry: current,
            summary,
            inferred,
        });

        if (transitions.length >= MAX_HISTORY) break;
    }

    return transitions;
}

function sign(value) {
    if (value > EPSILON) return 1;
    if (value < -EPSILON) return -1;
    return 0;
}

function directionalLabel(score) {
    if (score >= RAPID_THRESHOLD) return "Rapidly Warming";
    if (score >= GRADUAL_THRESHOLD) return "Gradually Warming";
    if (score <= -RAPID_THRESHOLD) return "Rapidly Deteriorating";
    if (score <= -GRADUAL_THRESHOLD) return "Gradually Deteriorating";
    return "Stable";
}

function summarizeDomainScores(transitions, weights) {
    const result = {};
    for (const category of CATEGORIES) {
        let score = 0;
        let weightTotal = 0;
        for (let i = 0; i < transitions.length; i++) {
            const domain = transitions[i].summary.domains[category];
            if (!domain) continue;
            score += domain.averageNet * weights[i];
            weightTotal += weights[i];
        }
        if (weightTotal > 0) result[category] = score / weightTotal;
    }
    return result;
}

function buildExplanation(label, transitionCount, checkpointCount, domainScores, detail, inferredCount = 0) {
    const domainParts = Object.entries(domainScores).map(([category, score]) => {
        const direction = score >= 1.25 ? "warming" : score <= -1.25 ? "cooling" : "stable";
        return `${category[0].toUpperCase()}${category.slice(1)}: ${direction}`;
    });

    const transitionText = `${transitionCount} comparable relationship transition${transitionCount === 1 ? "" : "s"}`;
    const checkpointText = `${checkpointCount} narrative checkpoint${checkpointCount === 1 ? "" : "s"}`;
    const inferredText = inferredCount > 0
        ? ` ${inferredCount} transition${inferredCount === 1 ? " was" : "s were"} reconstructed from adjacent Batch Scan/legacy checkpoints.`
        : "";

    return `${label} — derived from ${transitionText} across ${checkpointText}${domainParts.length ? `. ${domainParts.join(" · ")}` : ""}${detail ? `. ${detail}` : ""}.${inferredText}`;
}

/**
 * Derive a read-only trajectory from a character's recent narrative update log.
 * Sparse histories are valid: one real before→after transition is enough to
 * establish direction, while a lone snapshot is honestly labeled Baseline.
 *
 * @param {object} profile
 * @returns {{label:string, key:string, explanation:string, sampleSize:number, checkpointCount:number, domainScores:object}}
 */
export function deriveRelationshipTrajectory(profile) {
    const rawLog = Array.isArray(profile?.updateLog) ? profile.updateLog : [];
    const checkpoints = sortNarrativeHistory(rawLog);
    const transitions = buildTransitions(profile, checkpoints);

    if (transitions.length === 0) {
        if (checkpoints.length > 0 || hasEstablishedStats(profile)) {
            return {
                label: "Baseline",
                key: "baseline",
                explanation: checkpoints.length > 0
                    ? `Baseline — ${checkpoints.length} narrative checkpoint${checkpoints.length === 1 ? " exists" : "s exist"}, but there is not yet a second comparable state to establish direction.`
                    : "Baseline — relationship stats exist, but no narrative stat-transition history is available yet.",
                sampleSize: 0,
                checkpointCount: checkpoints.length,
                domainScores: {},
            };
        }

        return {
            label: "Unestablished",
            key: "unestablished",
            explanation: "No established relationship stats or narrative stat-transition history are available yet.",
            sampleSize: 0,
            checkpointCount: checkpoints.length,
            domainScores: {},
        };
    }

    // Newest-first, but only modestly weighted. Recent scenes matter more without
    // letting one scene erase the established direction of a rigid relationship.
    const weights = transitions.map((_, index) => Math.max(1, 1.5 - (index * 0.125)));
    const weightTotal = weights.reduce((sum, value) => sum + value, 0);
    const weightedNet = transitions.reduce((sum, item, index) => sum + (item.summary.averageNet * weights[index]), 0) / weightTotal;
    const weightedAbsolute = transitions.reduce((sum, item, index) => sum + (item.summary.averageAbsolute * weights[index]), 0) / weightTotal;
    const domainScores = summarizeDomainScores(transitions, weights);
    const inferredCount = transitions.filter((item) => item.inferred).length;

    const strongDomains = Object.values(domainScores).filter((score) => Math.abs(score) >= 2);
    const hasWarmDomain = strongDomains.some((score) => score > 0);
    const hasCoolDomain = strongDomains.some((score) => score < 0);
    if (hasWarmDomain && hasCoolDomain) {
        const label = "Polarized";
        return {
            label,
            key: "polarized",
            explanation: buildExplanation(label, transitions.length, checkpoints.length, domainScores, "Different relationship domains are moving in opposing directions", inferredCount),
            sampleSize: transitions.length,
            checkpointCount: checkpoints.length,
            domainScores,
        };
    }

    const sequence = transitions.map((item) => sign(item.summary.averageNet)).filter(Boolean);
    let flips = 0;
    for (let i = 1; i < sequence.length; i++) {
        if (sequence[i] !== sequence[i - 1]) flips += 1;
    }

    const totalPositive = transitions.reduce((sum, item, index) => {
        return sum + ((item.summary.positive / item.summary.compared) * weights[index]);
    }, 0);
    const totalNegative = transitions.reduce((sum, item, index) => {
        return sum + ((item.summary.negative / item.summary.compared) * weights[index]);
    }, 0);
    const mixedMovement = Math.min(totalPositive, totalNegative) >= Math.max(1.5, Math.max(totalPositive, totalNegative) * 0.35);
    if (flips >= 1 && mixedMovement && weightedAbsolute >= 3) {
        const label = "Volatile";
        return {
            label,
            key: "volatile",
            explanation: buildExplanation(label, transitions.length, checkpoints.length, domainScores, "Recent relationship movement changes direction substantially between checkpoints", inferredCount),
            sampleSize: transitions.length,
            checkpointCount: checkpoints.length,
            domainScores,
        };
    }

    // Sparse histories still deserve meaningful recovery labels. Rebuilding
    // requires a genuinely negative older transition, not a mild wobble.
    if (transitions.length >= 2) {
        const recent = transitions.slice(0, Math.min(2, transitions.length))
            .reduce((sum, item) => sum + item.summary.averageNet, 0) / Math.min(2, transitions.length);
        const olderTransitions = transitions.slice(Math.min(2, transitions.length));
        const older = olderTransitions.length > 0
            ? olderTransitions.reduce((sum, item) => sum + item.summary.averageNet, 0) / olderTransitions.length
            : transitions[1].summary.averageNet;

        if (older <= -4 && recent >= 2.5) {
            const label = "Rebuilding";
            return {
                label,
                key: "rebuilding",
                explanation: buildExplanation(label, transitions.length, checkpoints.length, domainScores, "Recent gains are reversing an earlier meaningful deterioration", inferredCount),
                sampleSize: transitions.length,
                checkpointCount: checkpoints.length,
                domainScores,
            };
        }

        // Fragile: broader direction is positive, but the newest transition is a
        // meaningful setback. This describes instability without erasing gains.
        if (weightedNet >= 2 && transitions[0].summary.averageNet <= -2.5) {
            const label = "Fragile";
            return {
                label,
                key: "fragile",
                explanation: buildExplanation(label, transitions.length, checkpoints.length, domainScores, "The broader trend is improving, but the newest transition is a meaningful setback", inferredCount),
                sampleSize: transitions.length,
                checkpointCount: checkpoints.length,
                domainScores,
            };
        }
    }

    if (weightedAbsolute < 0.75 || Math.abs(weightedNet) < 1.25) {
        const label = weightedAbsolute < 0.75 ? "Stagnant" : "Stable";
        return {
            label,
            key: label.toLowerCase(),
            explanation: buildExplanation(
                label,
                transitions.length,
                checkpoints.length,
                domainScores,
                label === "Stagnant" ? "Comparable checkpoints show almost no movement" : "Recent movement is small or largely balanced",
                inferredCount,
            ),
            sampleSize: transitions.length,
            checkpointCount: checkpoints.length,
            domainScores,
        };
    }

    const label = directionalLabel(weightedNet);
    return {
        label,
        key: label.toLowerCase().replace(/\s+/g, "-"),
        explanation: buildExplanation(label, transitions.length, checkpoints.length, domainScores, "Recent transitions are weighted slightly more heavily than older ones", inferredCount),
        sampleSize: transitions.length,
        checkpointCount: checkpoints.length,
        domainScores,
    };
}
