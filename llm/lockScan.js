/**
 * llm/lockScan.js — retroactive threshold-lock audit.
 *
 * Uses the same visible-message/chunk indexing as Batch Scan. Raw history is
 * read in chunks first to extract compact lock-relevant signals, then each
 * character is evaluated with Personality, Notes, current relationship state,
 * trajectory, milestones, conditions, summaries, existing locks, and those
 * historical signals. Existing lock slots are never silently overwritten.
 */

import { getSettings } from "../data/storage.js";
import { getAllCharacters, STAT_CATEGORIES, STAT_NAMES, getVisibleStatCategories, isStatCategoryVisible } from "../data/characters.js";
import { getAllSceneSummaries } from "../data/scenes.js";
import { deriveRelationshipTrajectory } from "../data/trajectory.js";
import { makeRequest, getPersonaContext, updateRateLimiterSettings } from "./connections.js";
import { buildHistoricalScanChunks } from "./batchScan.js";
import { dlog } from "../lib/debug.js";

const LOCK_TEXT_MAX = 1500;
const MAX_HISTORY_SIGNALS_PER_CHARACTER = 24;

export async function scanForLocks() {
    const settings = getSettings();
    const profileName = settings.connections?.statUpdateLLM;
    if (!profileName) {
        toastr?.error?.("No Stat Update LLM connection profile is set.");
        return [];
    }

    updateRateLimiterSettings(settings.batchScan || {});

    const all = getAllCharacters();
    const withPersona = all.filter((c) => c.description && c.description.trim().length > 0);
    const noPersonaCount = all.length - withPersona.length;

    const hasOpenSlot = (c) => {
        for (const cat of getVisibleStatCategories(c)) {
            for (const stat of STAT_NAMES) {
                const hard = c.hardLocks?.[cat]?.[stat];
                const soft = c.softLocks?.[cat]?.[stat];
                const hardOccupied = hard && typeof hard.cap === "number";
                const softOccupied = soft && typeof soft.cap === "number";
                if (!hardOccupied && !softOccupied) return true;
            }
        }
        return false;
    };
    const eligible = withPersona.filter(hasOpenSlot);
    const fullSkipped = withPersona.length - eligible.length;

    if (eligible.length === 0) {
        const why = noPersonaCount > 0 && fullSkipped > 0
            ? "Every character either has no Personality filled in or all visible lock slots are already occupied."
            : fullSkipped > 0
                ? "Every eligible character already has locks covering all visible stat slots."
                : "No characters have a Personality filled in — nothing to scan.";
        toastr?.info?.(why, "Relationship Stat Tracker");
        return [];
    }

    const configuredChunkSize = Number(settings.batchScan?.chunkSize);
    const maxMessages = Number.isFinite(configuredChunkSize)
        ? Math.max(10, Math.min(60, Math.round(configuredChunkSize)))
        : 30;
    const chunks = buildHistoricalScanChunks({ maxMessages, maxChars: 60000 });
    const historyByCharacter = await collectHistoricalLockSignals(chunks, eligible, profileName, settings);
    const pastSummaries = getAllSceneSummaries();

    dlog(`[RST] Lock scan: ${eligible.length} eligible, ${noPersonaCount} skipped (no personality), ${fullSkipped} skipped (all visible lock slots occupied), ${chunks.length} history chunks.`);

    const results = [];
    let errorCount = 0;
    let proposedNoneCount = 0;

    for (const char of eligible) {
        try {
            const proposed = await scanOneCharacter(char, pastSummaries, historyByCharacter.get(char.id) || [], profileName);
            if (proposed?.error) { errorCount++; continue; }
            const hard = proposed?.hardLocks || [];
            const soft = proposed?.softLocks || [];
            if (hard.length || soft.length) {
                results.push({ characterId: char.id, characterName: char.name, hardLocks: hard, softLocks: soft });
            } else {
                proposedNoneCount++;
            }
        } catch (err) {
            errorCount++;
            console.error(`[RST] Lock scan failed for ${char.name}:`, err);
        }
    }

    dlog(`[RST] Lock scan complete: ${eligible.length} scanned, ${results.length} with proposals, ${proposedNoneCount} returned none, ${errorCount} errored.`);
    if (errorCount > 0 && results.length === 0) {
        toastr?.warning?.(`Lock scan hit errors on ${errorCount} character(s) and got no usable proposals. Check F12.`, "Relationship Stat Tracker", { timeOut: 9000 });
    }
    return results;
}

async function collectHistoricalLockSignals(chunks, characters, profileName, settings) {
    const result = new Map(characters.map((c) => [c.id, []]));
    if (!chunks.length) return result;
    const validIds = new Set(characters.map((c) => c.id));
    const roster = characters.map((c) => `- ${c.id}: ${c.name}${Array.isArray(c.nameAliases) && c.nameAliases.length ? ` (aliases: ${c.nameAliases.slice(0, 6).join(", ")})` : ""}`).join("\n");

    const systemPrompt = [
        "You are extracting compact HISTORY SIGNALS for a later RST threshold-lock audit.",
        "Do NOT decide caps yet. Read the raw roleplay chunk and identify only behavior that may reveal a stable psychological ceiling (hard-lock signal) or a specific condition that must be met before deeper growth is plausible (soft-lock signal).",
        "Useful signals include repeated guardedness, refusal to rely on the persona, rigid principles, persistent avoidance, explicit prerequisites, or a demonstrated pattern that contradicts easy relationship growth.",
        "Do not treat a currently low stat, one bad mood, one argument, or ordinary dramatic tension as a lock by itself.",
        "Use ONLY supplied character IDs.",
        "Output JSON only: {\"characters\":{\"char_id\":[{\"kind\":\"hard\",\"stat\":\"platonic.openness\",\"summary\":\"...\"}]}}.",
    ].join("\n");

    const persona = getPersonaContext();
    for (const chunk of chunks) {
        const userPrompt = [
            `PERSONA: ${persona.name}`,
            persona.description ? `PERSONA CONTEXT: ${persona.description}` : "",
            "KNOWN CHARACTERS:", roster,
            "\nHISTORY CHUNK:", chunk.text,
            "\nReturn JSON only.",
        ].filter(Boolean).join("\n");
        try {
            const maxTokens = Math.max(2500, Number(settings.batchScan?.initialStatMaxTokens) || 3000);
            const raw = await makeRequest(profileName, systemPrompt, userPrompt, maxTokens, 0.15);
            const parsed = extractLockJson(raw);
            const charMap = parsed?.characters && typeof parsed.characters === "object" ? parsed.characters : {};
            for (const [charId, items] of Object.entries(charMap)) {
                if (!validIds.has(charId) || !Array.isArray(items)) continue;
                const bucket = result.get(charId);
                for (const item of items) {
                    if (!item || !["hard", "soft"].includes(String(item.kind || "").toLowerCase())) continue;
                    const statPath = String(item.stat || "").toLowerCase();
                    const [cat, stat] = statPath.split(".");
                    if (!STAT_CATEGORIES.includes(cat) || !STAT_NAMES.includes(stat)) continue;
                    const summary = String(item.summary || "").trim().slice(0, 800);
                    if (!summary) continue;
                    bucket.push({
                        kind: String(item.kind).toLowerCase(),
                        stat: `${cat}.${stat}`,
                        summary,
                    });
                    if (bucket.length >= MAX_HISTORY_SIGNALS_PER_CHARACTER) break;
                }
            }
        } catch (err) {
            console.error(`[RST] Lock history extraction failed for chunk ${chunk.start}-${chunk.end}:`, err);
        }
    }
    return result;
}

async function scanOneCharacter(char, pastSummaries, historicalSignals, profileName) {
    const systemPrompt = [
        "You set relationship-stat threshold locks for a character based on established psychology AND grounded relationship history.",
        "There are TWO lock types:",
        "- HARD lock: a stat cannot rise above the cap through ordinary growth because of a deep trait-level limit. Broken only by a rare fired critical moment.",
        "- SOFT lock: a stat is capped until the persona fulfills a specific narrative condition; then it can unlock.",
        "Output ONLY JSON: {\"hardLocks\":[{\"stat\":\"category.stat\",\"cap\":NUMBER,\"reason\":\"...\"}],\"softLocks\":[{\"stat\":\"category.stat\",\"cap\":NUMBER,\"condition\":\"...\",\"progress\":\"...\"}]}",
        "Only visible/active categories are allowed.",
        "Be CONSERVATIVE. Locks are exceptional. A typical character warrants 0-3 total, not a lock on every stat.",
        "Never lock merely because a stat is low. Require a defining personality barrier and/or a sustained historical pattern.",
        "Existing lock slots are READ-ONLY in this maintenance scan. Never replace, loosen, tighten, duplicate, or reinterpret them. Propose only for currently empty slots.",
        "Ground hard locks primarily in stable psychology corroborated by history. Ground soft locks in a specific relationship prerequisite supported by history/current dynamic.",
        "cap is -100 to 100 and may not be below the current stat value.",
        "If nothing new is justified, return empty arrays.",
    ].join("\n");

    const visibleCategories = getVisibleStatCategories(char);
    const persona = getPersonaContext();
    const trajectory = deriveRelationshipTrajectory(char);
    const parts = [
        `CHARACTER: ${char.name}`,
        `VISIBLE/ACTIVE CATEGORIES: ${visibleCategories.join(", ") || "NONE"}`,
        `PERSONALITY: ${char.description}`,
    ];
    if (char.notes?.trim()) parts.push(`NOTES: ${char.notes}`);
    parts.push(`\nPERSONA: ${persona.name}`);
    if (persona.description) parts.push(`PERSONA CONTEXT: ${persona.description}`);
    parts.push(`When writing soft-lock conditions, refer to the persona as "${persona.name}".`);

    if (char.dynamicTitle?.trim()) parts.push(`\nCURRENT DYNAMIC: ${char.dynamicTitle}`);
    if (char.narrativeSummary?.trim()) parts.push(`CURRENT NARRATIVE: ${char.narrativeSummary}`);
    parts.push(`CURRENT TRAJECTORY: ${trajectory.label} — ${trajectory.explanation}`);

    parts.push("\nCURRENT STATS:");
    for (const cat of visibleCategories) {
        const s = char.stats?.[cat] || {};
        parts.push(`  ${cat}: trust=${s.trust ?? 0}%, openness=${s.openness ?? 0}%, support=${s.support ?? 0}%, affection=${s.affection ?? 0}%`);
    }

    const existing = [];
    for (const cat of visibleCategories) {
        for (const stat of STAT_NAMES) {
            const hard = char.hardLocks?.[cat]?.[stat];
            const soft = char.softLocks?.[cat]?.[stat];
            if (hard && typeof hard.cap === "number") existing.push(`${cat}.${stat}: HARD ${hard.cap}% — ${hard.reason || "no reason"}`);
            if (soft && typeof soft.cap === "number") existing.push(`${cat}.${stat}: SOFT ${soft.cap}% until ${soft.condition || "condition unspecified"}${soft.met ? " (resolved history)" : ""}`);
        }
    }
    if (existing.length) {
        parts.push("\nEXISTING LOCKS — READ ONLY, DO NOT REPLACE:");
        parts.push(...existing.map((x) => `  - ${x}`));
    }

    const milestones = Array.isArray(char.relationshipMilestones) ? char.relationshipMilestones.slice(-8) : [];
    if (milestones.length) {
        parts.push("\nRELATIONSHIP MILESTONES:");
        parts.push(...milestones.map((m) => `  - ${m.title}: ${m.description}`));
    }
    const conditions = Array.isArray(char.relationshipConditions) ? char.relationshipConditions.filter((c) => c && c.active !== false).slice(-8) : [];
    if (conditions.length) {
        parts.push("\nACTIVE TEMPORARY CONDITIONS:");
        parts.push(...conditions.map((c) => `  - ${c.label || c.type || "Condition"}: ${c.reason || c.effect || ""}`));
    }

    if (historicalSignals.length) {
        parts.push("\nFULL-HISTORY PATTERNS EXTRACTED FROM RAW CHAT CHUNKS:");
        for (const signal of historicalSignals) {
            parts.push(`  - ${signal.kind.toUpperCase()} candidate ${signal.stat}: ${signal.summary}`);
        }
    } else {
        parts.push("\nFULL-HISTORY PATTERNS: No strong lock-specific pattern was extracted from the raw chat. This strongly favors proposing no new locks unless Personality/current state independently makes a defining ceiling unmistakable.");
    }

    if (pastSummaries?.length) {
        const recent = pastSummaries.slice(-6).map((s, i) => `  [${i}] ${typeof s === "string" ? s : (s.summary || s.llmSummary || "")}`);
        parts.push("\nRECENT SCENE SUMMARIES (secondary context):", ...recent);
    }

    parts.push("\nReturn JSON only.");
    const resultText = await makeRequest(profileName, systemPrompt, parts.join("\n"), 20000, 0.2);
    if (!resultText) return { hardLocks: [], softLocks: [], error: "no_response" };

    const parsed = extractLockJson(resultText);
    if (!parsed) return { hardLocks: [], softLocks: [], error: "parse_failed" };
    const rawHard = Array.isArray(parsed.hardLocks) ? parsed.hardLocks : (Array.isArray(parsed.locks) ? parsed.locks : []);
    const rawSoft = Array.isArray(parsed.softLocks) ? parsed.softLocks : [];

    const validHard = [];
    for (const l of rawHard) {
        if (!l || typeof l.stat !== "string" || typeof l.cap !== "number") continue;
        const [cat, stat] = l.stat.toLowerCase().split(".");
        if (!STAT_CATEGORIES.includes(cat) || !STAT_NAMES.includes(stat) || !isStatCategoryVisible(char, cat)) continue;
        const hardExisting = char.hardLocks?.[cat]?.[stat];
        const softExisting = char.softLocks?.[cat]?.[stat];
        if ((hardExisting && typeof hardExisting.cap === "number") || (softExisting && typeof softExisting.cap === "number")) continue;
        let cap = Math.max(-100, Math.min(100, Math.round(l.cap)));
        const cur = char.stats?.[cat]?.[stat] ?? 0;
        if (cap < cur) cap = cur;
        const reason = String(l.reason || "").trim().slice(0, LOCK_TEXT_MAX);
        if (!reason) continue;
        validHard.push({ stat: `${cat}.${stat}`, cap, reason });
    }

    const validSoft = [];
    for (const l of rawSoft) {
        if (!l || typeof l.stat !== "string" || typeof l.cap !== "number") continue;
        const [cat, stat] = l.stat.toLowerCase().split(".");
        if (!STAT_CATEGORIES.includes(cat) || !STAT_NAMES.includes(stat) || !isStatCategoryVisible(char, cat)) continue;
        const hardExisting = char.hardLocks?.[cat]?.[stat];
        const softExisting = char.softLocks?.[cat]?.[stat];
        if ((hardExisting && typeof hardExisting.cap === "number") || (softExisting && typeof softExisting.cap === "number")) continue;
        const condition = String(l.condition || "").trim().slice(0, LOCK_TEXT_MAX);
        if (!condition) continue;
        let cap = Math.max(-100, Math.min(100, Math.round(l.cap)));
        const cur = char.stats?.[cat]?.[stat] ?? 0;
        if (cap < cur) cap = cur;
        validSoft.push({
            stat: `${cat}.${stat}`,
            cap,
            condition,
            progress: String(l.progress || "").trim().slice(0, LOCK_TEXT_MAX),
        });
    }
    return { hardLocks: validHard, softLocks: validSoft };
}

function extractLockJson(text) {
    if (!text) return null;
    const raw = String(text).trim();
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fence ? fence[1].trim() : raw;
    try { return JSON.parse(candidate); } catch { /* continue */ }
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start !== -1 && end > start) {
        try { return JSON.parse(candidate.slice(start, end + 1)); } catch { /* ignore */ }
    }
    return null;
}
