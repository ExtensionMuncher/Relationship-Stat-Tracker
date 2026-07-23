/**
 * milestoneScan.js — retroactive relationship milestone backfill.
 *
 * Reads the current chat in Batch-Scan-compatible chunks, extracts conservative
 * persona<->character milestone candidates, then performs a per-character
 * consolidation pass. Nothing is written here; callers review/apply.
 */

import { getSettings } from "../data/storage.js";
import { getAllCharacters, STAT_CATEGORIES, getVisibleStatCategories } from "../data/characters.js";
import { makeRequest, getPersonaContext, updateRateLimiterSettings } from "./connections.js";
import { buildHistoricalScanChunks } from "./batchScan.js";
import { dlog } from "../lib/debug.js";

const MAX_MILESTONE_TEXT = 1200;
const MAX_FINAL_MILESTONES_PER_CHARACTER = 12;

export async function scanHistoricalMilestones() {
    const settings = getSettings();
    const profileName = settings.connections?.statUpdateLLM;
    if (!profileName) {
        toastr?.error?.("No Stat Update LLM connection profile is set.");
        return [];
    }

    updateRateLimiterSettings(settings.batchScan || {});

    const characters = getAllCharacters();
    if (!characters.length) {
        toastr?.info?.("No RST character profiles exist in this chat.", "Relationship Stat Tracker");
        return [];
    }

    const configuredChunkSize = Number(settings.batchScan?.chunkSize);
    const maxMessages = Number.isFinite(configuredChunkSize)
        ? Math.max(10, Math.min(60, Math.round(configuredChunkSize)))
        : 30;
    const chunks = buildHistoricalScanChunks({ maxMessages, maxChars: 60000 });
    if (!chunks.length) {
        toastr?.info?.("No visible chat history is available to scan.", "Relationship Stat Tracker");
        return [];
    }

    const persona = getPersonaContext();
    const personaAliases = collectPersonaAliases(chunks, persona);
    const roster = characters.map((c) => ({
        id: c.id,
        name: c.name,
        aliases: Array.isArray(c.nameAliases) ? c.nameAliases.slice(0, 12) : [],
    }));
    const validIds = new Set(roster.map((c) => c.id));

    const candidatesByCharacter = new Map();
    let errorCount = 0;
    let candidateSerial = 0;

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        try {
            const extracted = await extractChunkMilestones(chunk, roster, persona, personaAliases, profileName, settings);
            for (const raw of extracted) {
                if (!raw || !validIds.has(raw.characterId)) continue;
                const domains = [...new Set((Array.isArray(raw.domains) ? raw.domains : [])
                    .map((d) => String(d || "").toLowerCase())
                    .filter((d) => STAT_CATEGORIES.includes(d)))];
                const candidate = {
                    candidateId: `milestone_candidate_${candidateSerial++}`,
                    title: String(raw.title || "Relationship turning point").trim().slice(0, 160),
                    description: String(raw.description || "").trim().slice(0, MAX_MILESTONE_TEXT),
                    domains,
                };
                if (!candidate.description) continue;
                if (!candidatesByCharacter.has(raw.characterId)) candidatesByCharacter.set(raw.characterId, []);
                candidatesByCharacter.get(raw.characterId).push(candidate);
            }
        } catch (err) {
            errorCount++;
            console.error(`[RST] Milestone backfill failed on history chunk ${chunk.start}-${chunk.end}:`, err);
        }
    }

    const results = [];
    for (const char of characters) {
        const candidates = candidatesByCharacter.get(char.id) || [];
        if (!candidates.length) continue;
        try {
            const milestones = await synthesizeCharacterMilestones(char, candidates, persona, personaAliases, profileName, settings);
            if (milestones.length) {
                results.push({ characterId: char.id, characterName: char.name, milestones });
            }
        } catch (err) {
            errorCount++;
            console.error(`[RST] Milestone synthesis failed for ${char.name}:`, err);
        }
    }

    dlog(`[RST] Milestone backfill: ${chunks.length} history chunks, ${results.length} characters with proposed milestones, ${errorCount} errors.`);
    if (errorCount > 0 && results.length === 0) {
        toastr?.warning?.(`Milestone backfill encountered ${errorCount} error(s) and produced no usable results. Check F12.`, "Relationship Stat Tracker", { timeOut: 9000 });
    }
    return results;
}

async function extractChunkMilestones(chunk, roster, persona, personaAliases, profileName, settings) {
    const systemPrompt = [
        "You are doing a RETROACTIVE relationship-history audit for Relationship Stat Tracker (RST).",
        "RST tracks ONLY the relationship between the USER/PERSONA and each individual RST character.",
        "Every milestone you return MUST describe a durable change in PERSONA <-> TARGET CHARACTER relationship. Third-party relationships are categorically invalid.",
        "Examples of INVALID milestones: Mira bonding with Kellan, Dorian changing Kellan's life, two NPCs reconciling, or a character having an important event that does not materially change how that character and the persona relate to each other. Merely mentioning or worrying about the persona inside an NPC<->NPC scene does NOT make that scene a persona relationship milestone.",
        "A valid milestone is rare and durable: a major rupture, reconciliation, explicit commitment/vow, decisive betrayal, relationship-defining rescue/sacrifice, serious boundary violation, or a disclosure/action that materially changes how the target character and persona treat or understand EACH OTHER afterward.",
        "Do NOT inflate ordinary emotion into a milestone. A thank-you, sandwich, quiet companionship, encouragement, routine comfort, first conversation, first meeting, ordinary vulnerability, banter, generic fight, apology without durable consequence, or a dramatic scene is NOT a milestone by itself.",
        "'First genuine trust/vulnerability' qualifies only when the scene shows a consequential relationship-state change, not merely someone saying something personal once.",
        "Milestones are NOT routine stat movement and NOT numeric threshold crossings. Most chunks should return zero.",
        "Use ONLY the provided character IDs. Never invent a profile.",
        "Describe only what is actually established in this chunk. Do not infer a later consequence that is not shown here.",
        "Output JSON only: {\"milestones\":[{\"characterId\":\"...\",\"title\":\"...\",\"description\":\"...\",\"domains\":[\"platonic\"]}]}",
    ].join("\n");

    const rosterText = roster.map((c) => `- ${c.id}: ${c.name}${c.aliases.length ? ` (aliases: ${c.aliases.join(", ")})` : ""}`).join("\n");
    const userPrompt = [
        `PERSONA: ${persona.name}`,
        personaAliases.length ? `PERSONA NAMES/ALIASES SEEN IN CHAT: ${personaAliases.join(", ")}` : "",
        persona.description ? `PERSONA CONTEXT: ${persona.description}` : "",
        "KNOWN RST CHARACTERS:",
        rosterText,
        `\nHISTORY CHUNK:`,
        chunk.text,
        "\nReturn JSON only. Remember: USER/PERSONA <-> TARGET CHARACTER only; third-party relationship milestones are invalid.",
    ].filter(Boolean).join("\n");

    const maxTokens = Math.max(2500, Number(settings.batchScan?.initialStatMaxTokens) || 3000);
    const raw = await makeRequest(profileName, systemPrompt, userPrompt, maxTokens, 0.15);
    const parsed = extractJson(raw);
    return Array.isArray(parsed?.milestones) ? parsed.milestones : [];
}

async function synthesizeCharacterMilestones(char, candidates, persona, personaAliases, profileName, settings) {
    const visibleDomains = getVisibleStatCategories(char);
    const existing = Array.isArray(char.relationshipMilestones) ? char.relationshipMilestones : [];
    const candidateById = new Map(candidates.map((c) => [c.candidateId, c]));

    const systemPrompt = [
        "You are consolidating retroactive relationship milestone candidates for ONE RST character.",
        `The ONLY relationship being summarized is PERSONA (${persona.name}) <-> TARGET CHARACTER (${char.name}).`,
        "Reject anything whose actual relationship change is between two NPCs/characters, even if the persona is nearby, mentioned, worried about, discussed, or is the reason the two NPCs are talking.",
        "Select only durable, relationship-defining turning points. Sparse is better than a scrapbook.",
        "A thank-you, food/comfort gesture, ordinary encouragement, first meeting, routine apology, ordinary disclosure, or single vulnerable line is not enough unless the supplied candidate itself shows a lasting redefinition of the persona-target relationship.",
        "Do not use current stats, title, narrative summary, or personality to invent a historical event. The candidate blocks below are the ONLY historical source.",
        "Merge duplicate candidates only when they describe the same persona-target turning point.",
        "Choose candidate IDs. Do not invent a new historical event outside the supplied candidates.",
        "Do not repeat an existing milestone.",
        `Return at most ${MAX_FINAL_MILESTONES_PER_CHARACTER} milestones, and fewer when warranted.`,
        "Output JSON only: {\"milestones\":[{\"candidateIds\":[\"milestone_candidate_...\"],\"title\":\"...\",\"description\":\"...\",\"domains\":[\"platonic\"]}]}",
    ].join("\n");

    const candidateLines = candidates.map((c) =>
        `ID=${c.candidateId}\n   ${c.title}\n   ${c.description}\n   domains=${c.domains.join(",") || "unspecified"}`
    );
    const existingLines = existing.map((m) => `- ${m.title}: ${m.description}`);

    const userPrompt = [
        `TARGET CHARACTER: ${char.name}`,
        `PERSONA: ${persona.name}`,
        personaAliases.length ? `PERSONA NAMES/ALIASES: ${personaAliases.join(", ")}` : "",
        `VISIBLE RELATIONSHIP DOMAINS: ${visibleDomains.join(", ") || "none"}`,
        existingLines.length ? "\nEXISTING MILESTONES (do not duplicate):" : "",
        ...existingLines,
        "\nCANDIDATES:",
        ...candidateLines,
        "\nReturn JSON only. Select candidate IDs only from the supplied list.",
    ].filter(Boolean).join("\n");

    const maxTokens = Math.max(3000, Number(settings.batchScan?.initialStatMaxTokens) || 3000);
    const raw = await makeRequest(profileName, systemPrompt, userPrompt, maxTokens, 0.1);
    const parsed = extractJson(raw);
    const rawMilestones = Array.isArray(parsed?.milestones) ? parsed.milestones : [];
    const existingTitles = new Set(existing.map((m) => normalizeText(m.title)));
    const out = [];

    for (const rawMs of rawMilestones) {
        if (!rawMs) continue;
        const selectedIds = [...new Set((Array.isArray(rawMs.candidateIds) ? rawMs.candidateIds : [])
            .map((id) => String(id || "").trim())
            .filter((id) => candidateById.has(id)))];
        if (!selectedIds.length) continue;

        const selectedCandidates = selectedIds.map((id) => candidateById.get(id)).filter(Boolean);
        const title = String(rawMs.title || selectedCandidates[0]?.title || "Relationship turning point").trim().slice(0, 160);
        const description = String(rawMs.description || selectedCandidates[0]?.description || "").trim().slice(0, MAX_MILESTONE_TEXT);
        if (!title || !description || existingTitles.has(normalizeText(title))) continue;

        let domains = [...new Set((Array.isArray(rawMs.domains) ? rawMs.domains : [])
            .map((d) => String(d || "").toLowerCase())
            .filter((d) => visibleDomains.includes(d)))];
        if (!domains.length) {
            domains = [...new Set(selectedCandidates.flatMap((c) => c.domains).filter((d) => visibleDomains.includes(d)))];
        }
        if (!domains.length && visibleDomains.length === 1) domains = [visibleDomains[0]];

        out.push({ title, description, domains });
        existingTitles.add(normalizeText(title));
        if (out.length >= MAX_FINAL_MILESTONES_PER_CHARACTER) break;
    }

    return out;
}

function collectPersonaAliases(chunks, persona) {
    const values = new Set();
    addNameVariants(values, persona?.name);
    for (const chunk of chunks) {
        for (const m of chunk.messages || []) {
            if (m?.isUser) addNameVariants(values, m.name);
        }
    }
    return [...values].filter(Boolean).slice(0, 16);
}

function addNameVariants(set, value) {
    const raw = String(value || "").trim();
    if (!raw) return;
    set.add(raw);
    const parts = raw.split(/\s+/).filter((part) => part.length >= 3);
    if (parts.length > 1) {
        for (const part of parts) set.add(part);
    }
}

function normalizeText(value) {
    return String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
}

function extractJson(text) {
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
