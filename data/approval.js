import { getCharacterProfile as readProfile, getSoftLockAvailability, ensurePressure, HARD_LOCK_PRESSURE_MAX, MAX_UPDATE_LOG, STAT_CATEGORIES, STAT_NAMES } from "./characters.js";
import { saveCharacter, getPendingUpdates } from "./storage.js";
import { getSceneById, getClosedSceneCountForChar } from "./scenes.js";
import { getRelationshipConditionDefinition, MAX_ACTIVE_RELATIONSHIP_CONDITIONS } from "./conditions.js";
import { dlog } from "../lib/debug.js";

export function snapshotRelationshipState(profile) {
    return structuredClone(Object.fromEntries(["stats", "dynamicTitle", "narrativeSummary", "hardLocks", "softLocks", "relationshipMilestones", "relationshipConditions"].map(key => [key, profile[key] ?? (key.endsWith("Title") || key.endsWith("Summary") ? "" : null)])));
}

const MEANINGFUL_ARRAY_FIELDS = [
    "raisedCaps", "proposedHardLocks", "proposedSoftLocks", "unlockedSoftLocks",
    "softLockProgress", "hardLockPressureUpdates", "hardLockReviews",
    "proposedMilestones", "proposedConditions", "resolvedConditions",
];

/**
 * True only when approving the card would change durable relationship state.
 * Commentary and bookkeeping metadata alone are intentionally not changes.
 * @param {object} update
 * @param {object|null} [profile]
 */
export function isMeaningfulCharacterUpdate(update, profile = null) {
    if (!update) return false;
    const beforeStats = update.statsBefore || update.stateBefore?.stats || profile?.stats;
    if (beforeStats && update.statsAfter) {
        for (const cat of STAT_CATEGORIES) for (const stat of STAT_NAMES) {
            if (beforeStats?.[cat]?.[stat] !== update.statsAfter?.[cat]?.[stat]) return true;
        }
    }
    if (MEANINGFUL_ARRAY_FIELDS.some((field) => Array.isArray(update[field]) && update[field].length > 0)) return true;

    const beforeTitle = update.dynamicTitleBefore ?? update.stateBefore?.dynamicTitle ?? profile?.dynamicTitle ?? "";
    const afterTitle = update.dynamicTitleAfter ?? beforeTitle;
    if (String(afterTitle) !== String(beforeTitle)) return true;

    const beforeSummary = update.stateBefore?.narrativeSummary ?? profile?.narrativeSummary ?? "";
    const afterSummary = update.narrativeSummary ?? beforeSummary;
    return String(afterSummary) !== String(beforeSummary);
}

export function commitCharacterUpdate(charUpdate, sceneId) {
    const pending = getPendingUpdates();
    if (pending?.sceneId !== sceneId || !pending?.characterUpdates?.includes(charUpdate)) throw new Error("This update is no longer pending. Reopen Home.");
    const current = readProfile(charUpdate.characterId);
    if (!current) throw new Error("Character no longer exists.");
    if (!isMeaningfulCharacterUpdate(charUpdate, current)) throw new Error("No relationship changes to approve.");
    const stateBefore = snapshotRelationshipState(current);
    if (charUpdate.stateBefore && JSON.stringify(stateBefore) !== JSON.stringify(charUpdate.stateBefore)) throw new Error("Character state changed after generation. Regenerate this update before approving.");
    for (const cat of STAT_CATEGORIES) for (const stat of STAT_NAMES) {
        if (!Number.isFinite(charUpdate.statsAfter?.[cat]?.[stat])) throw new Error("Invalid or incomplete stat update.");
        if (charUpdate.statsBefore && current.stats?.[cat]?.[stat] !== charUpdate.statsBefore?.[cat]?.[stat]) throw new Error("Stats changed after generation. Regenerate this update before approving.");
    }
    charUpdate = structuredClone(charUpdate);
    const validStat = value => {
        const [cat, stat, extra] = String(value || "").split(".");
        return !extra && STAT_CATEGORIES.includes(cat) && STAT_NAMES.includes(stat);
    };
    for (const field of ["raisedCaps", "proposedHardLocks", "proposedSoftLocks", "softLockProgress", "hardLockPressureUpdates", "hardLockReviews"]) {
        charUpdate[field] = (Array.isArray(charUpdate[field]) ? charUpdate[field] : []).filter(item => item && validStat(item.stat));
    }
    for (const field of ["proposedHardLocks", "proposedSoftLocks"]) charUpdate[field] = charUpdate[field].filter(item => Number.isFinite(item.cap) && item.cap >= -100 && item.cap <= 100);
    charUpdate.raisedCaps = charUpdate.raisedCaps.filter(item => Number.isFinite(item.to) && item.to >= -100 && item.to <= 100);
    charUpdate.unlockedSoftLocks = (Array.isArray(charUpdate.unlockedSoftLocks) ? charUpdate.unlockedSoftLocks : []).filter(validStat);
    if (!isMeaningfulCharacterUpdate(charUpdate, current)) throw new Error("No valid relationship changes to approve.");
    const draft = structuredClone(current);
    const getCharacterProfile = () => draft;
    const updateCharacterStats = (_id, stats) => { draft.stats = Object.fromEntries(STAT_CATEGORIES.map(cat => [cat, Object.fromEntries(STAT_NAMES.map(stat => [stat, Math.max(-100, Math.min(100, stats[cat][stat]))]))])); };
    const updateCharacterProfile = (_id, fields) => Object.assign(draft, fields);
    const addUpdateLogEntry = (_id, entry) => { draft.updateLog = [entry, ...(draft.updateLog || [])].slice(0, MAX_UPDATE_LOG); };
        // Commit stats
        dlog("[RST] Committing stats for:", charUpdate.characterName, charUpdate.statsAfter);
        updateCharacterStats(charUpdate.characterId, charUpdate.statsAfter);

        // Apply any hard-lock caps that a critical raised this scene. The cap
        // rises to the broken-through value so future normal growth can fill up
        // to the new ceiling, and a further critical is needed to climb again.
        const hasRaised = Array.isArray(charUpdate.raisedCaps) && charUpdate.raisedCaps.length > 0;
        const hasProposed = Array.isArray(charUpdate.proposedHardLocks) && charUpdate.proposedHardLocks.length > 0;
        if (hasRaised || hasProposed) {

            const prof = getCharacterProfile(charUpdate.characterId);
            if (prof && prof.hardLocks) {
                // Critical-raised caps: cap rises to the broken-through value.
                for (const rc of (charUpdate.raisedCaps || [])) {
                    const [cat, stat] = String(rc.stat).split(".");
                    if (prof.hardLocks[cat] && prof.hardLocks[cat][stat]) {
                        prof.hardLocks[cat][stat].cap = rc.to;
                    }
                }
                // Newly proposed locks from the LLM (approved alongside the update).
                // Hard requirement: never apply LLM-proposed locks to a character
                // whose Personality (description) is empty — the model would be
                // guessing on a blank slate. Manual user-set locks are unaffected.
                const personaFilled = !!(prof.description && prof.description.trim());
                for (const pl of (personaFilled ? (charUpdate.proposedHardLocks || []) : [])) {
                    if (!pl || typeof pl.cap !== 'number') continue;
                    const [cat, stat] = String(pl.stat).split(".");
                    if (prof.hardLocks[cat] && prof.hardLocks[cat][stat]) {
                        const cur = prof.hardLocks[cat][stat].cap;
                        // Don't lower an existing higher cap; only set/tighten when sensible.
                        if (cur === null || pl.cap > cur) {
                            prof.hardLocks[cat][stat] = { cap: pl.cap, reason: pl.reason || "" };
                        }
                    }
                }
                updateCharacterProfile(charUpdate.characterId, { hardLocks: prof.hardLocks });
                dlog("[RST] Applied lock changes:", { raised: charUpdate.raisedCaps, proposed: charUpdate.proposedHardLocks });
            }
        }

        // ── Soft lock application ──
        const hasSoftProp = Array.isArray(charUpdate.proposedSoftLocks) && charUpdate.proposedSoftLocks.length > 0;
        const hasUnlocked = Array.isArray(charUpdate.unlockedSoftLocks) && charUpdate.unlockedSoftLocks.length > 0;
        const hasProgress = Array.isArray(charUpdate.softLockProgress) && charUpdate.softLockProgress.length > 0;
        if (hasSoftProp || hasUnlocked || hasProgress) {

            const prof = getCharacterProfile(charUpdate.characterId);
            if (prof && prof.softLocks) {
                const personaFilled = !!(prof.description && prof.description.trim());


                const sceneCount = getClosedSceneCountForChar(charUpdate.characterId);

                // 1) Resolve met conditions FIRST (auto-unlock). Stamp setAtScene so
                //    the cooldown clock starts ticking from when the lock resolved.
                for (const key of (charUpdate.unlockedSoftLocks || [])) {
                    const [cat, stat] = String(key).split(".");
                    const sl = prof.softLocks[cat]?.[stat];
                    if (sl && sl.cap !== null && !sl.met) {
                        sl.met = true;
                        sl.setAtScene = sceneCount; // resolution resets the cooldown clock
                    }
                }
                // 2) Progress notes for still-locked soft locks.
                for (const pr of (charUpdate.softLockProgress || [])) {
                    if (!pr || !pr.stat) continue;
                    const [cat, stat] = String(pr.stat).split(".");
                    const sl = prof.softLocks[cat]?.[stat];
                    if (sl && sl.cap !== null && !sl.met) {
                        sl.progress = String(pr.progress || "").trim().slice(0, 1500);
                    }
                }
                // 3) New proposed soft locks — gated by personality, the 1-active
                //    cap, and the cooldown. Mechanical enforcement so the LLM can't
                //    flood locks even if it ignores the CLOSED signal in the prompt.
                //    Only the FIRST valid proposal is taken (cap = 1).
                if (personaFilled) {
                    const avail = getSoftLockAvailability(prof, sceneCount);
                    if (avail.allowed) {
                        let addedForChar = 0;
                        for (const sl of (charUpdate.proposedSoftLocks || [])) {
                            if (addedForChar >= avail.slotsFree) break; // respect the configurable max
                            if (!sl || typeof sl.cap !== 'number') continue;
                            const [cat, stat] = String(sl.stat).split(".");
                            const slot = prof.softLocks[cat]?.[stat];
                            if (!slot) continue;
                            // Only fill an empty/resolved slot, and require a condition.
                            if ((slot.cap === null || slot.met) && sl.condition && String(sl.condition).trim()) {
                                prof.softLocks[cat][stat] = {
                                    cap: sl.cap,
                                    condition: String(sl.condition || "").trim().slice(0, 1500),
                                    progress: String(sl.progress || "").trim().slice(0, 1500),
                                    met: false,
                                    setAtScene: sceneCount,
                                };
                                addedForChar++;
                            }
                        }
                    } else {
                        dlog("[RST] Soft lock proposal suppressed:", avail.reason);
                    }
                }
                updateCharacterProfile(charUpdate.characterId, { softLocks: prof.softLocks });
                dlog("[RST] Applied soft-lock changes:", { proposed: charUpdate.proposedSoftLocks, unlocked: charUpdate.unlockedSoftLocks });
            }
        }

        // ── Hard lock pressure application ──
        // Pressure tracks evidence against a lock's reason. It NEVER changes the
        // stat value. Only stats that already have a hard lock can gain pressure.
        const hasPressure = Array.isArray(charUpdate.hardLockPressureUpdates) && charUpdate.hardLockPressureUpdates.length > 0;
        const hasReviews = Array.isArray(charUpdate.hardLockReviews) && charUpdate.hardLockReviews.length > 0;
        if (hasPressure || hasReviews) {

            const prof = getCharacterProfile(charUpdate.characterId);
            if (prof && prof.hardLocks) {
                for (const pu of (charUpdate.hardLockPressureUpdates || [])) {
                    if (!pu || !pu.stat) continue;
                    const [cat, stat] = String(pu.stat).split(".");
                    const lock = prof.hardLocks[cat]?.[stat];
                    // Guard: pressure only applies where a hard lock actually exists.
                    if (!lock || typeof lock.cap !== "number") continue;
                    ensurePressure(lock);
                    let change = parseInt(pu.change, 10);
                    if (isNaN(change)) continue;
                    change = Math.max(-2, Math.min(2, change));
                    if (change === 0) continue;
                    const before = lock.pressure.value;
                    const max = lock.pressure.max || HARD_LOCK_PRESSURE_MAX;
                    lock.pressure.value = Math.max(0, Math.min(max, before + change));
                    lock.pressure.reason = String(pu.reason || "").trim().slice(0, 1500);
                    lock.pressure.lastUpdated = Date.now();
                    if (lock.pressure.value >= max) lock.pressure.needsReview = true;
                    dlog(`[RST] Pressure ${cat}.${stat}: ${before} -> ${lock.pressure.value} (${change > 0 ? "+" : ""}${change})`);
                }
                // Attach any review recommendations the LLM provided for maxed locks.
                for (const rv of (charUpdate.hardLockReviews || [])) {
                    if (!rv || !rv.stat) continue;
                    const [cat, stat] = String(rv.stat).split(".");
                    const lock = prof.hardLocks[cat]?.[stat];
                    if (!lock || typeof lock.cap !== "number") continue;
                    ensurePressure(lock);
                    // Only honor a review when the lock is actually at/over max pressure.
                    if (lock.pressure.value < (lock.pressure.max || HARD_LOCK_PRESSURE_MAX)) continue;
                    const rec = String(rv.recommendation || "maintain");
                    const validRecs = ["maintain", "raise_cap", "convert_to_soft", "remove"];
                    lock.pressure.needsReview = true;
                    lock.pressure.recommendation = {
                        recommendation: validRecs.includes(rec) ? rec : "maintain",
                        recommendedCap: (typeof rv.recommendedCap === "number") ? Math.max(-100, Math.min(100, rv.recommendedCap)) : lock.cap,
                        reason: String(rv.reason || "").trim().slice(0, 1500),
                    };
                }
                updateCharacterProfile(charUpdate.characterId, { hardLocks: prof.hardLocks });
                dlog("[RST] Applied hard-lock pressure changes.");
            }
        }

        // Update dynamic title and narrative
        updateCharacterProfile(charUpdate.characterId, {
            dynamicTitle: charUpdate.dynamicTitleAfter,
            narrativeSummary: charUpdate.narrativeSummary,
        });

        // Get actual message range from the scene
        const scene = sceneId ? getSceneById(sceneId) : null;
        const messageRange = scene
            ? { start: scene.messageStart, end: scene.messageEnd }
            : null; // No scene available — skip message range in log entry

        // Commit read-only milestones + temporary conditions only after the user
        // approves the same stat-update card. This keeps all three systems in sync.
        const profileSystemChanges = { milestonesAdded: [], conditionsAdded: [], conditionsResolved: [] };
        const profileState = getCharacterProfile(charUpdate.characterId);
        if (profileState) {
            const now = Date.now();
            let milestones = Array.isArray(profileState.relationshipMilestones) ? [...profileState.relationshipMilestones] : [];
            for (const ms of (charUpdate.proposedMilestones || [])) {
                if (!ms?.title || !ms?.description) continue;
                const milestone = {
                    id: `milestone_${now}_${milestones.length}`,
                    title: String(ms.title).trim().slice(0, 120),
                    description: String(ms.description).trim().slice(0, 1200),
                    domains: Array.isArray(ms.domains) ? ms.domains.slice(0, 3) : [],
                    sceneId: sceneId || "",
                    timestamp: now,
                };
                milestones.push(milestone);
                profileSystemChanges.milestonesAdded.push(milestone.id);
            }

            let conditions = Array.isArray(profileState.relationshipConditions) ? [...profileState.relationshipConditions] : [];
            const resolvedIds = new Set((charUpdate.resolvedConditions || []).map((c) => c?.id).filter(Boolean));
            if (resolvedIds.size) {
                profileSystemChanges.conditionsResolved = conditions
                    .filter((condition) => resolvedIds.has(condition.id))
                    .map((condition) => structuredClone(condition));
                conditions = conditions.filter((condition) => !resolvedIds.has(condition.id));
            }

            const activeTypes = new Set(conditions.map((condition) => condition?.type).filter(Boolean));
            for (const proposal of (charUpdate.proposedConditions || [])) {
                if (conditions.length >= MAX_ACTIVE_RELATIONSHIP_CONDITIONS) break;
                const def = getRelationshipConditionDefinition(proposal?.type);
                if (!def || activeTypes.has(proposal.type) || !String(proposal.reason || "").trim() || !String(proposal.resolution || "").trim()) continue;
                const condition = {
                    id: `condition_${proposal.type}_${now}_${conditions.length}`,
                    type: proposal.type,
                    reason: String(proposal.reason || "").trim().slice(0, 1200),
                    resolution: String(proposal.resolution || "").trim().slice(0, 1200),
                    sceneId: sceneId || "",
                    startedAt: now,
                };
                conditions.push(condition);
                profileSystemChanges.conditionsAdded.push(condition.id);
                activeTypes.add(proposal.type);
            }

            updateCharacterProfile(charUpdate.characterId, {
                relationshipMilestones: milestones,
                relationshipConditions: conditions,
            });
        }

        // Create update log entry
        dlog("[RST] Adding update log entry for:", charUpdate.characterName, { statsBefore: stateBefore.stats, statsAfter: charUpdate.statsAfter, commentary: charUpdate.commentary });
        addUpdateLogEntry(charUpdate.characterId, {
            sceneId: sceneId || "",
            messageRange,
            timestamp: Math.max(Date.now(), (draft.updateLog?.[0]?.timestamp || 0) + 1),
            statsBefore: stateBefore.stats,
            statsAfter: charUpdate.statsAfter,
            commentary: charUpdate.commentary,
            dynamicTitleBefore: charUpdate.dynamicTitleBefore,
            dynamicTitleAfter: charUpdate.dynamicTitleAfter,
            narrativeSummary: charUpdate.narrativeSummary,
            criticalStats: charUpdate.criticalStats || [],
            profileSystemChanges,
            stateBefore,
            stateAfter: snapshotRelationshipState(draft),
            source: charUpdate.source || "unknown",
        });


    saveCharacter(charUpdate.characterId, draft);
    return draft;
}
