import { captureChatScope } from "../lib/chatScope.js";
/** Chronological, stateful backfill for temporary relationship statuses. */
import { getSettings } from "../data/storage.js";
import { getAllCharacters } from "../data/characters.js";
import { RELATIONSHIP_CONDITION_CATALOG, MAX_ACTIVE_RELATIONSHIP_CONDITIONS } from "../data/conditions.js";
import { makeRequest, getPersonaContext, updateRateLimiterSettings } from "./connections.js";
import { buildHistoricalScanChunks } from "./batchScan.js";

export async function scanHistoricalConditions(onProgress = null) {
    const rstScope1 = captureChatScope();

    const settings = getSettings();
    const profileName = settings.connections?.statUpdateLLM;
    if (!profileName) throw new Error("No Stat Update LLM connection profile is set.");
    updateRateLimiterSettings(settings.batchScan || {});
    const characters = structuredClone(getAllCharacters());
    if (!characters.length) return [];
    const configured = Number(settings.batchScan?.chunkSize);
    const maxMessages = Number.isFinite(configured) ? Math.max(10, Math.min(60, Math.round(configured))) : 30;
    const chunks = buildHistoricalScanChunks({ maxMessages, maxChars: 60000 });
    if (!chunks.length) return [];
    const roster = characters.map((c) => ({ id: c.id, name: c.name, aliases: c.nameAliases || [] }));
    const validIds = new Set(roster.map((c) => c.id));
    const state = new Map(roster.map((c) => [c.id, new Map()]));
    const transitions = new Map(roster.map((c) => [c.id, []]));
    const persona = getPersonaContext();
    for (let i = 0; i < chunks.length; i++) {
        onProgress?.(i + 1, chunks.length, chunks[i]);
        const actions = await rstScope1.wait(() => (scanConditionChunk(chunks[i], roster, state, persona, profileName, settings)));
        applyConditionActions(state, transitions, actions, chunks[i], validIds);
    }
    return characters.map((character) => ({ characterId: character.id, characterName: character.name,
        previousConditions: structuredClone(Array.isArray(character.relationshipConditions) ? character.relationshipConditions : []),
        finalConditions: [...state.get(character.id).values()], transitions: transitions.get(character.id) }));
}

async function scanConditionChunk(chunk, roster, state, persona, profileName, settings) {
    const rstScope2 = captureChatScope();

    const types = Object.entries(RELATIONSHIP_CONDITION_CATALOG).map(([type, def]) => `${type}=${def.label}: ${def.meaning}`).join("\n");
    const carried = roster.flatMap((c) => {
    if (!rstScope2.isCurrent()) return;

        const conditions = [...state.get(c.id).values()];
        return conditions.length ? conditions.map((x) => `- ${c.id} (${c.name}) [${x.type}]: ${x.reason} | resolves when: ${x.resolution}`) : [`- ${c.id} (${c.name}): none`];
    }).join("\n");
    const rosterText = roster.map((c) => `- ${c.id}: ${c.name}${c.aliases.length ? ` (aliases: ${c.aliases.join(", ")})` : ""}`).join("\n");
    const system = [
        "You are chronologically reconstructing CURRENT temporary relationship statuses for RST.",
        "Track only each listed character's relationship toward the USER/PERSONA. Never track NPC-to-NPC states.",
        "Process this chunk after the supplied carried state. Return only transitions established by this chunk.",
        "activate: a meaningful temporary lens begins. refresh: it remains active but materially develops. resolve: this chunk actually satisfies its stored resolution rule or clearly ends the state.",
        "A status must be directed toward the persona. Suspicion of another NPC while discussing the persona does not mean suspicion of the persona. Resolution may include positive maturation (tentative trust becoming established), not only betrayal or deterioration.",
        "Do not resolve merely because a status is not mentioned. Do not activate permanent personality traits, ordinary moods, or momentary reactions.",
        "Most characters and chunks should have no actions. Never infer beyond this chunk.",
        `Never leave more than ${MAX_ACTIVE_RELATIONSHIP_CONDITIONS} active statuses per character.`,
        'Output JSON only: {"actions":[{"characterId":"...","op":"activate|refresh|resolve","type":"guarded","reason":"current evidence","resolution":"specific future development that ends it"}]}',
    ].join("\n");
    const user = [`PERSONA: ${persona.name}`, persona.description ? `PERSONA CONTEXT: ${persona.description}` : "",
        "KNOWN CHARACTERS:", rosterText, "ALLOWED STATUS TYPES:", types,
        "CARRIED STATE ENTERING THIS CHUNK:", carried, `HISTORY CHUNK ${chunk.start}-${chunk.end}:`, chunk.text,
        "Return only transitions caused by this chunk. Preserve unmentioned active statuses by returning no action for them."].filter(Boolean).join("\n");
    const maxTokens = Math.max(2500, Number(settings.batchScan?.initialStatMaxTokens) || 3000);
    const parsed = extractJson(await rstScope2.wait(() => (makeRequest(profileName, system, user, maxTokens, 0.1))));
    if (!parsed || !Array.isArray(parsed.actions)) throw new Error(`Invalid temporary-status response for chunk ${chunk.start}-${chunk.end}`);
    return parsed.actions;
}

export function applyConditionActions(state, transitions, actions, chunk, validIds = new Set(state.keys())) {
    if (!Array.isArray(actions)) throw new Error("Invalid temporary-status actions.");
    const nextState = new Map([...state].map(([id, values]) => [id, new Map(values)]));
    const nextTrail = new Map([...transitions].map(([id, values]) => [id, [...values]]));
    for (const raw of actions) {
        const characterId = String(raw?.characterId || "").trim();
        const op = String(raw?.op || "").trim().toLowerCase();
        const type = String(raw?.type || "").trim();
        if (!validIds.has(characterId) || !["activate", "refresh", "resolve"].includes(op) || !RELATIONSHIP_CONDITION_CATALOG[type]) throw new Error(`Invalid temporary-status transition in chunk ${chunk.start}-${chunk.end}.`);
        const active = nextState.get(characterId), existing = active.get(type);
        const reason = typeof raw.reason === "string" ? raw.reason.trim().slice(0, 1200) : "";
        const resolution = typeof raw.resolution === "string" ? raw.resolution.trim().slice(0, 1200) : (existing?.resolution || "");
        if (!reason || (op !== "activate" && !existing) || (op === "activate" && existing)) throw new Error(`Inconsistent ${op} for ${characterId}/${type}.`);
        if (op === "resolve") active.delete(type);
        else {
            if (!resolution || (!existing && active.size >= MAX_ACTIVE_RELATIONSHIP_CONDITIONS)) throw new Error(`Invalid activation/refresh for ${characterId}/${type}.`);
            active.set(type, { type, reason, resolution, source: "condition_backfill", messageRange: { start: chunk.start, end: chunk.end } });
        }
        nextTrail.get(characterId).push({ op, type, reason, messageRange: { start: chunk.start, end: chunk.end } });
    }
    for (const [id, active] of nextState) state.set(id, active);
    for (const [id, trail] of nextTrail) transitions.set(id, trail);
}

function extractJson(text) {
    if (!text) return null;
    const raw = String(text).trim(), fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i), candidate = fence ? fence[1].trim() : raw;
    try { return JSON.parse(candidate); } catch { /* continue */ }
    const start = candidate.indexOf("{"), end = candidate.lastIndexOf("}");
    if (start !== -1 && end > start) { try { return JSON.parse(candidate.slice(start, end + 1)); } catch { /* ignore */ } }
    return null;
}
