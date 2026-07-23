/**
 * sidecar.js — Sidecar LLM: constrained character-presence reconciliation
 *
 * Presence is updated as a set of explicit transitions, not regenerated from the
 * whole character library. The sidecar only sees characters already present or
 * characters whose safe identity aliases occur in the scanned prose.
 */

import { chat } from "../../../../../script.js";
import { getContext } from "../../../../extensions.js";
import { makeRequest } from "./connections.js";
import {
    getSettings,
    getNameBlacklist,
    getPresentCharacters,
    getPresenceModes,
    isNameBlacklisted,
} from "../data/storage.js";
import { getAllCharacters } from "../data/characters.js";
import { dlog } from "../lib/debug.js";

const MAX_MESSAGE_CHARS = 2200;
const MAX_TEXT_CANDIDATES = 20;
const MAX_TOTAL_CANDIDATES = 28;
const SIDECAR_MAX_TOKENS = 4096;

const GENERIC_UNKNOWN_NAMES = new Set([
    "user", "assistant", "system", "narrator", "unknown", "someone", "somebody",
    "person", "man", "woman", "boy", "girl", "guy", "lady", "sir", "ma'am",
    "mother", "father", "mom", "dad", "brother", "sister", "friend", "officer",
    "detective", "doctor", "nurse", "teacher", "professor", "boss", "manager",
]);

const DESCRIPTIVE_ALIAS_WORDS = new Set([
    "my", "your", "his", "her", "their", "our", "its", "someone's", "someones",
    "brother", "sister", "mother", "father", "manager", "boss", "friend", "ex",
    "boyfriend", "girlfriend", "husband", "wife", "coworker", "colleague",
]);

// ─── Sidecar Detection ────────────────────────────────────

/**
 * Reconcile current character presence from recent messages.
 * @param {number|null} [messageCount=null]
 * @returns {Promise<{detected:string[], unknown:string[], modes:Object, valid:boolean, reason?:string}>}
 */
export async function detectCharacters(messageCount = null) {
    const settings = getSettings();
    const allCharacters = getAllCharacters();
    const currentNames = getCurrentCanonicalNames(allCharacters);
    const currentModes = getCurrentCanonicalModes(allCharacters);

    if (!settings.enabled) {
        return { detected: currentNames, unknown: [], modes: currentModes, valid: false, reason: "disabled" };
    }

    const profileName = settings.connections?.sidecarLLM;
    const count = messageCount ?? (settings.messagesToScan || 10);
    const messages = getRecentMessages(count);
    const personaName = getContext().name1 || "";

    if (messages.length === 0) {
        return { detected: currentNames, unknown: [], modes: currentModes, valid: false, reason: "no_messages" };
    }

    const candidateState = buildCandidateState(
        messages,
        allCharacters,
        personaName,
        Math.max(1, Number(settings.scanFrequency) || 3),
    );
    const safeCurrentNames = candidateState.currentProfiles.map((profile) => profile.name);
    const safeCurrentModes = Object.fromEntries(
        candidateState.currentProfiles.map((profile) => [profile.name, candidateState.currentModes[profile.id] || "unknown"]),
    );

    const systemPrompt = buildSidecarSystemPrompt();
    const requestPrompt = buildSidecarRequestPrompt(messages, candidateState, personaName);

    dlog(
        `[RST] detectCharacters: profile=${profileName || "(none)"}, messages=${messages.length}, ` +
        `library=${allCharacters.length}, current=${candidateState.currentProfiles.length}, ` +
        `candidates=${candidateState.candidates.length}, corruptCurrent=${candidateState.currentWasCorrupt}`,
    );

    try {
        const result = await makeRequest(
            profileName,
            systemPrompt,
            requestPrompt,
            SIDECAR_MAX_TOKENS,
            0.1,
        );

        dlog(
            "[RST] detectCharacters: LLM response received, len=" + (result ? result.length : 0) +
            ", preview=" + (result ? result.substring(0, 240) : "null"),
        );

        if (!result) {
            return { detected: safeCurrentNames, unknown: [], modes: safeCurrentModes, valid: false, reason: "empty_response" };
        }

        const decision = parsePresenceDecision(result);
        if (!decision) {
            console.warn("[RST] Presence detection returned no valid JSON object; preserving current presence.");
            return { detected: safeCurrentNames, unknown: [], modes: safeCurrentModes, valid: false, reason: "invalid_json" };
        }

        const reconciled = reconcilePresenceDecision(decision, messages, candidateState, personaName);
        if (!reconciled.valid) {
            console.warn(`[RST] Presence response failed validation (${reconciled.reason}); preserving current presence.`);
            return { detected: safeCurrentNames, unknown: [], modes: safeCurrentModes, valid: false, reason: reconciled.reason };
        }

        dlog(
            "[RST] Presence reconciliation accepted — detected:", JSON.stringify(reconciled.detected),
            "unknown:", JSON.stringify(reconciled.unknown),
            "modes:", JSON.stringify(reconciled.modes),
        );
        return reconciled;
    } catch (err) {
        console.error("[RST] Sidecar detection failed:", err);
        toastr?.error?.("Sidecar character detection failed. Check your connection settings.");
        return { detected: safeCurrentNames, unknown: [], modes: safeCurrentModes, valid: false, reason: "request_error" };
    }
}

// ─── Prompt Building ──────────────────────────────────────

function buildSidecarSystemPrompt() {
    return [
        "You reconcile which non-player characters are actively involved in the CURRENT scene.",
        "Do not list everyone mentioned. Report only explicit presence transitions.",
        "Output ONLY one valid JSON object. No markdown, reasoning, analysis, or commentary.",
    ].join("\n");
}

function buildSidecarRequestPrompt(messages, candidateState, personaName) {
    const lines = messages.map((message, index) => {
        const role = message.is_user ? "USER" : "ASSISTANT";
        if (candidateState.embeddedDocumentIndices.has(index)) {
            return `[M${index} ${role}] [EMBEDDED DOCUMENT OR IN-WORLD TEXT OMITTED — do not treat its cast as present]`;
        }
        return `[M${index} ${role}] ${truncateMessage(message.mes || "")}`;
    });

    const candidateLines = candidateState.candidates.length > 0
        ? candidateState.candidates.map((candidate) => {
            const flags = [];
            if (candidate.wasPresent) flags.push(`CURRENT:${candidate.currentMode}`);
            const evidence = [...candidate.transitionEvidence].map((i) => `M${i}`).join(",") || "none";
            return `${candidate.key} = ${candidate.profile.name} | ${flags.join("+") || "NEW_TEXT_CANDIDATE"} | new-message identity evidence: ${evidence}`;
        })
        : ["(none)"];

    const ignoredNames = [...new Set([
        personaName,
        ...(getNameBlacklist() || []),
    ].map((name) => String(name || "").trim()).filter(Boolean))];

    return [
        "Return exactly this schema:",
        '{"sceneReset":{"active":false,"evidence":[]},"present":[{"id":"C1","mode":"physical","evidence":[0]}],"departed":[{"id":"C2","evidence":[3]}],"unknown":[{"name":"Jane Doe","mode":"physical","evidence":[2]}]}',
        "",
        "DEFINITIONS:",
        "- PHYSICAL: currently at the active scene location, participating, observing, or being acted upon. Use mode physical.",
        "- LIVE CALL: actively involved through a phone/video/radio call. Use mode call.",
        "- SURVEILLANCE: actively observing or directing through a live surveillance channel. Use mode surveillance.",
        "- LIVE MESSAGE: actively exchanging real-time messages. Use mode message.",
        "- OTHER REMOTE: another deliberate real-time channel. Use mode remote.",
        "- PARALLEL ACTIVE SCENE: the top-level narrative camera follows this character at another location while they actively observe, assess, react to, decide about, or act on current developments involving the player. Use mode parallel.",
        "- MENTION ONLY: discussed, remembered, planned to visit later, quoted from the past, named in a report, or appearing only inside a book/document. Mention-only characters are NOT present.",
        "",
        "RULES:",
        `- This is a transition report. Only M${candidateState.transitionStartIndex} through M${messages.length - 1} are NEW since the prior scan. Report additions from those NEW messages only. Older messages are context only.`,
        "- Omit unchanged current characters from both present and departed, except a CURRENT:unknown candidate may be restated in present to classify its mode.",
        "- Add a non-current candidate only when a cited message explicitly shows active physical, live-remote, or parallel narrative involvement NOW.",
        "- A parallel scene counts even when the character is physically distant, provided the narration actually follows that character and shows them actively processing or acting on current player-related developments.",
        "- Future, hypothetical, reported, merely discussed, or reference-only involvement does not count. A current parallel POV may include memories or private thoughts, but the character must be actively situated in the present narrative and the reflection must bear on the current player-related thread.",
        "- Remove a current character only when a cited message explicitly ends that character's involvement, or a genuine top-level scene transition replaces the scene.",
        "- A call ending removes the live remote caller, not every current character.",
        "- Do not use the ASSISTANT message label as character evidence; SillyTavern may label narration with the card name even when that character is absent.",
        "- sceneReset may be true only for an actual top-level time/location/camera transition. A genuine cut to or away from a parallel POV is a scene transition. Markdown inside a book, post, message, report, or other in-world document is not a scene reset.",
        "- Use only candidate IDs listed below. Never output another known library character.",
        "- Unknown names must be proper names written verbatim in the cited message and actively involved now.",
        "- Evidence numbers are zero-based M indices.",
        "- Empty arrays are valid and preferred over guessing.",
        ignoredNames.length ? `- Never return ignored/player names: ${ignoredNames.join(", ")}` : "",
        "",
        "ELIGIBLE KNOWN CANDIDATES:",
        ...candidateLines,
        "",
        "RECENT MESSAGES:",
        ...lines,
    ].filter(Boolean).join("\n");
}

// ─── Candidate Construction ───────────────────────────────

function buildCandidateState(messages, allCharacters, personaName, transitionMessageCount = 3) {
    const currentIds = new Set(getPresentCharacters());
    const storedModes = getPresenceModes();
    let currentProfiles = allCharacters.filter((profile) => currentIds.has(profile.id));

    // Recover from the historical failure mode where a malformed sidecar response
    // promoted essentially the whole library. A legitimate large cast remains
    // possible, but an all/near-all list of 8+ profiles is not trusted as continuity.
    const corruptionThreshold = Math.max(8, Math.ceil(allCharacters.length * 0.9));
    const currentWasCorrupt = currentProfiles.length >= corruptionThreshold && currentProfiles.length >= allCharacters.length - 1;
    if (currentWasCorrupt) {
        console.warn("[RST] Current presence resembles a whole-library dump; discarding it as corrupted continuity.");
        currentProfiles = [];
    }

    const currentProfileIds = new Set(currentProfiles.map((profile) => profile.id));
    const currentModes = {};
    for (const profile of currentProfiles) {
        currentModes[profile.id] = normalizeMode(storedModes?.[profile.id]);
    }

    const identityVariants = buildCharacterIdentityVariants(allCharacters, personaName);
    const candidatesById = new Map();
    const embeddedDocumentIndices = new Set();
    const transitionStartIndex = Math.max(0, messages.length - Math.max(1, transitionMessageCount));

    function ensureCandidate(profile) {
        if (!candidatesById.has(profile.id)) {
            candidatesById.set(profile.id, {
                profile,
                wasPresent: currentProfileIds.has(profile.id),
                currentMode: currentModes[profile.id] || "unknown",
                matchEvidence: new Set(),
                transitionEvidence: new Set(),
                matchedVariants: new Map(),
                latestEvidence: -1,
            });
        }
        return candidatesById.get(profile.id);
    }

    for (const profile of currentProfiles) ensureCandidate(profile);

    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        if (isEmbeddedDocumentMessage(message, messages[index - 1])) {
            embeddedDocumentIndices.add(index);
            continue;
        }

        const bodyText = message.mes || "";
        for (const profile of allCharacters) {
            if (isNameBlacklisted(profile.name, [personaName, "{{user}}", "user"])) continue;
            const variants = identityVariants.get(profile.id) || [];
            const matched = variants.filter((variant) => nameAppears(bodyText, variant));
            if (matched.length === 0) continue;

            const candidate = ensureCandidate(profile);
            candidate.matchEvidence.add(index);
            if (index >= transitionStartIndex) candidate.transitionEvidence.add(index);
            candidate.matchedVariants.set(index, matched);
            candidate.latestEvidence = Math.max(candidate.latestEvidence, index);
        }
    }

    // Migrate legacy/manual presence entries from unknown to a usable mode when
    // the scanned prose provides explicit evidence. This does not add/remove
    // anyone; it only makes later call-end and scene-reset validation reliable.
    for (const candidate of candidatesById.values()) {
        if (!candidate.wasPresent) continue;
        let inferredMode = "unknown";
        for (const index of [...candidate.matchEvidence].sort((a, b) => a - b)) {
            if (embeddedDocumentIndices.has(index)) continue;
            const mode = findCandidateActiveMode(messages[index], candidate, identityVariants, personaName);
            if (mode !== "unknown") inferredMode = mode;
        }
        if (inferredMode !== "unknown") {
            candidate.currentMode = inferredMode;
            currentModes[candidate.profile.id] = inferredMode;
        }
    }

    const currentCandidates = [...candidatesById.values()].filter((candidate) => candidate.wasPresent);
    const textCandidateLimit = Math.max(0, Math.min(
        MAX_TEXT_CANDIDATES,
        MAX_TOTAL_CANDIDATES - currentCandidates.length,
    ));
    const textCandidates = [...candidatesById.values()]
        .filter((candidate) => !candidate.wasPresent && candidate.transitionEvidence.size > 0)
        .sort((a, b) => b.latestEvidence - a.latestEvidence)
        .slice(0, textCandidateLimit);

    const selected = [...currentCandidates, ...textCandidates];
    selected.forEach((candidate, index) => {
        candidate.key = `C${index + 1}`;
    });

    return {
        candidates: selected,
        candidateByKey: new Map(selected.map((candidate) => [candidate.key, candidate])),
        currentProfiles,
        currentModes,
        currentWasCorrupt,
        embeddedDocumentIndices,
        identityVariants,
        transitionStartIndex,
        personaName,
    };
}

function buildCharacterIdentityVariants(allCharacters, personaName = "") {
    const canonicalTokenOwners = new Map();
    const canonicalTokensById = new Map();
    const excludedIdentityNames = [personaName, "{{user}}", "user", ...(getNameBlacklist() || [])]
        .map((name) => String(name || "").trim())
        .filter(Boolean);
    const excludedTokens = new Set(
        excludedIdentityNames.flatMap((name) => searchableText(name).split(/\s+/).filter(Boolean)),
    );

    for (const profile of allCharacters) {
        const tokens = searchableText(profile.name)
            .split(/\s+/)
            .filter(isUsableCanonicalNameToken)
            .filter((token) => !excludedTokens.has(token));
        canonicalTokensById.set(profile.id, tokens);
        for (const token of tokens) {
            if (!canonicalTokenOwners.has(token)) canonicalTokenOwners.set(token, new Set());
            canonicalTokenOwners.get(token).add(profile.id);
        }
    }

    const result = new Map();
    for (const profile of allCharacters) {
        const variants = new Set();
        const mainName = normalizeForMatch(profile.name);
        if (mainName && !isNameBlacklisted(profile.name, excludedIdentityNames)) variants.add(mainName);

        for (const token of canonicalTokensById.get(profile.id) || []) {
            if (canonicalTokenOwners.get(token)?.size === 1
                && !isNameBlacklisted(token, excludedIdentityNames)) {
                variants.add(token);
            }
        }

        for (const alias of profile.nameAliases || []) {
            const rawAlias = String(alias || "").trim();
            if (!isSafeIdentityAlias(rawAlias)) continue;
            if (isNameBlacklisted(rawAlias, excludedIdentityNames)) continue;
            variants.add(normalizeForMatch(rawAlias));
        }

        result.set(profile.id, [...variants].filter(Boolean));
    }
    return result;
}

function isSafeIdentityAlias(alias) {
    if (!alias) return false;
    const normalized = normalizeForMatch(alias);
    const words = normalized.split(/\s+/).filter(Boolean);
    if (words.length === 0 || words.length > 6) return false;
    if (/[{}]/.test(alias)) return false;
    if (/\b(my|your|his|her|their|our|its)\b/i.test(alias)) return false;
    if (/\b\w+'s\b/i.test(alias)) return false;
    if (words.some((word) => DESCRIPTIVE_ALIAS_WORDS.has(word))) return false;

    // Preserve explicit aliases/titles exactly, but never split them into their
    // ordinary component words. At least one word must look deliberately named.
    return alias.split(/\s+/).some((word) => {
        const cleaned = word.replace(/^[^\p{L}]+|[^\p{L}.]+$/gu, "");
        return /^[\p{Lu}][\p{L}\p{M}'’.-]*$/u.test(cleaned)
            || containsCJK(cleaned);
    });
}

function isUsableCanonicalNameToken(token) {
    if (!token) return false;
    if (containsCJK(token)) return token.length >= 1;
    return token.length >= 3 && !GENERIC_UNKNOWN_NAMES.has(token);
}

// ─── Response Parsing and Reconciliation ──────────────────

function parsePresenceDecision(response) {
    if (!response || typeof response !== "string") return null;
    const raw = response.trim();
    const cleaned = raw.replace(/```(?:json)?\s*/gi, "").replace(/\s*```/g, "").trim();

    const directAttempts = raw === cleaned ? [raw] : [raw, cleaned];
    for (const text of directAttempts) {
        const parsed = tryParseDecision(text);
        if (parsed) return parsed;
    }

    const objects = extractBalancedJsonObjects(cleaned);
    for (let i = objects.length - 1; i >= 0; i--) {
        const parsed = tryParseDecision(objects[i]);
        if (parsed) return parsed;
    }
    return null;
}

function tryParseDecision(text) {
    try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        if (!Array.isArray(parsed.present) || !Array.isArray(parsed.departed) || !Array.isArray(parsed.unknown)) return null;
        return parsed;
    } catch {
        return null;
    }
}

function extractBalancedJsonObjects(text) {
    const results = [];
    for (let start = 0; start < text.length; start++) {
        if (text[start] !== "{") continue;
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let i = start; i < text.length; i++) {
            const char = text[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (char === "\\") escaped = true;
                else if (char === '"') inString = false;
                continue;
            }
            if (char === '"') inString = true;
            else if (char === "{") depth++;
            else if (char === "}") {
                depth--;
                if (depth === 0) {
                    results.push(text.slice(start, i + 1));
                    start = i;
                    break;
                }
            }
        }
    }
    return results;
}

function reconcilePresenceDecision(decision, messages, candidateState, personaName) {
    const currentIds = new Set(candidateState.currentProfiles.map((profile) => profile.id));
    const selectedIds = new Set(currentIds);
    const selectedModes = { ...candidateState.currentModes };

    // Parallel POV presence is deliberately ephemeral. Keep it while the full
    // recent scan window still contains explicit active parallel evidence; once
    // that POV has fallen out of context, retire it automatically. This gives
    // pronoun-heavy continuation a grace window without making a one-off remote
    // scene permanently present.
    for (const candidate of candidateState.candidates) {
        if (!candidate.wasPresent || normalizeMode(candidate.currentMode) !== "parallel") continue;
        const stillInRecentParallelScene = [...candidate.matchEvidence].some((index) => {
            if (candidateState.embeddedDocumentIndices.has(index)) return false;
            return findCandidateActiveMode(messages[index], candidate, candidateState.identityVariants, candidateState.personaName) === "parallel";
        });
        if (!stillInRecentParallelScene) {
            selectedIds.delete(candidate.profile.id);
            delete selectedModes[candidate.profile.id];
        }
    }

    const reset = normalizeSceneReset(decision.sceneReset, messages.length);
    const resetIndex = reset.active
        ? reset.evidence.find((index) => isStrongSceneBoundary(messages[index], messages[index - 1]))
        : undefined;

    if (reset.active && resetIndex === undefined) {
        dlog("[RST] Ignoring unsupported sceneReset; cited messages are not top-level scene boundaries.");
    }

    if (resetIndex !== undefined) {
        // Physical/manual presence belongs to the replaced scene. Explicit remote
        // involvement survives unless separately ended because surveillance/calls
        // may continue across a location cut.
        for (const profile of candidateState.currentProfiles) {
            const mode = normalizeMode(selectedModes[profile.id]);
            if ((!isRemoteMode(mode) || mode === "parallel") && mode !== "unknown") {
                selectedIds.delete(profile.id);
                delete selectedModes[profile.id];
            }
        }
    }

    const remoteCurrentCandidates = candidateState.candidates.filter((candidate) =>
        candidate.wasPresent && isRemoteMode(normalizeMode(candidate.currentMode)),
    );
    const physicalCurrentCandidates = candidateState.candidates.filter((candidate) =>
        candidate.wasPresent && !isRemoteMode(normalizeMode(candidate.currentMode)),
    );

    for (const item of decision.departed) {
        const normalized = normalizeKnownDecisionItem(item, messages.length);
        if (!normalized) continue;
        const candidate = candidateState.candidateByKey.get(normalized.id);
        if (!candidate || !currentIds.has(candidate.profile.id)) continue;

        const supported = normalized.evidence.some((index) => {
            if (candidateState.embeddedDocumentIndices.has(index)) return false;
            return hasCandidateLinkedDeparture(
                messages,
                index,
                candidate,
                remoteCurrentCandidates,
                physicalCurrentCandidates,
                candidateState.identityVariants,
            );
        });
        if (!supported) continue;

        selectedIds.delete(candidate.profile.id);
        delete selectedModes[candidate.profile.id];
    }

    for (const item of decision.present) {
        const normalized = normalizeKnownDecisionItem(item, messages.length);
        if (!normalized) continue;
        const candidate = candidateState.candidateByKey.get(normalized.id);
        if (!candidate) continue;
        if (currentIds.has(candidate.profile.id)) {
            selectedIds.add(candidate.profile.id);
            for (const index of normalized.evidence) {
                if (!candidate.matchEvidence.has(index) || candidateState.embeddedDocumentIndices.has(index)) continue;
                const inferred = findCandidateActiveMode(messages[index], candidate, candidateState.identityVariants, candidateState.personaName);
                if (inferred !== "unknown") {
                    selectedModes[candidate.profile.id] = inferred;
                    break;
                }
            }
            continue;
        }

        let supportedEvidence;
        let inferredMode = "unknown";
        for (const index of normalized.evidence) {
            if (!candidate.matchEvidence.has(index) || !candidate.transitionEvidence.has(index)) continue;
            if (candidateState.embeddedDocumentIndices.has(index)) continue;
            const mode = findCandidateActiveMode(messages[index], candidate, candidateState.identityVariants, candidateState.personaName);
            if (mode === "unknown") continue;
            if (hasLaterEndingEvidence(messages, index, candidate, mode, candidateState.identityVariants, candidateState.personaName)) continue;
            supportedEvidence = index;
            inferredMode = mode;
            break;
        }
        if (supportedEvidence === undefined) continue;

        selectedIds.add(candidate.profile.id);
        selectedModes[candidate.profile.id] = inferredMode;
    }

    const detectedProfiles = candidateState.candidates.filter((candidate) => selectedIds.has(candidate.profile.id));
    const detected = detectedProfiles.map((candidate) => candidate.profile.name);
    const modes = Object.fromEntries(
        detectedProfiles.map((candidate) => [candidate.profile.name, normalizeMode(selectedModes[candidate.profile.id])]),
    );

    const unknown = [];
    for (const item of decision.unknown) {
        const normalized = normalizeUnknownDecisionItem(item, messages.length);
        if (!normalized) continue;
        if (isNameBlacklisted(normalized.name, [personaName, "{{user}}", "user"])) continue;
        if (!looksLikeProperName(normalized.name)) continue;

        let supportedEvidence;
        let inferredMode = "unknown";
        for (const index of normalized.evidence) {
            if (index < candidateState.transitionStartIndex) continue;
            if (candidateState.embeddedDocumentIndices.has(index)) continue;
            const mode = findUnknownActiveMode(messages[index], normalized.name, candidateState.personaName);
            if (mode === "unknown") continue;
            supportedEvidence = index;
            inferredMode = mode;
            break;
        }
        if (supportedEvidence === undefined) continue;

        if (!unknown.some((name) => normalizeForMatch(name) === normalizeForMatch(normalized.name))) {
            unknown.push(normalized.name.trim());
            modes[normalized.name.trim()] = inferredMode;
        }
    }

    // If a suspicious response attempts to promote almost every available text
    // candidate at once, fail closed. Genuine large entrances should be split
    // across explicit evidence and can be added manually if necessary.
    const nonCurrentCandidates = candidateState.candidates.filter((candidate) => !candidate.wasPresent);
    const addedCount = detectedProfiles.filter((candidate) => !candidate.wasPresent).length;
    if (nonCurrentCandidates.length >= 5 && addedCount >= Math.ceil(nonCurrentCandidates.length * 0.8)) {
        return { detected: [], unknown: [], modes: {}, valid: false, reason: "suspicious_bulk_addition" };
    }

    return { detected, unknown, modes, valid: true };
}

function normalizeSceneReset(value, messageCount) {
    if (value === true) return { active: true, evidence: [] };
    if (!value || typeof value !== "object") return { active: false, evidence: [] };
    return {
        active: value.active === true,
        evidence: normalizeEvidence(value.evidence, messageCount),
    };
}

function normalizeKnownDecisionItem(item, messageCount) {
    if (!item || typeof item !== "object") return null;
    const id = String(item.id || "").trim();
    if (!/^C\d+$/.test(id)) return null;
    return { id, evidence: normalizeEvidence(item.evidence, messageCount) };
}

function normalizeUnknownDecisionItem(item, messageCount) {
    if (!item || typeof item !== "object") return null;
    const name = String(item.name || "").trim();
    if (!name) return null;
    return { name, evidence: normalizeEvidence(item.evidence, messageCount) };
}

function normalizeEvidence(value, messageCount) {
    const values = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
    return [...new Set(values
        .map((entry) => {
            if (typeof entry === "string") return Number(entry.replace(/^M/i, ""));
            return Number(entry);
        })
        .filter((entry) => Number.isInteger(entry) && entry >= 0 && entry < messageCount))];
}

// ─── Evidence Validation ──────────────────────────────────

function findCandidateActiveMode(message, candidate, identityVariants, personaName = "") {
    const text = message?.mes || "";
    if (!text || isEmbeddedDocumentMessage(message, null)) return "unknown";
    const variants = identityVariants.get(candidate.profile.id) || [];
    const messagePlayerReference = hasDirectPlayerReference(text, personaName);
    let lastMode = "unknown";

    // A single assistant response may contain several location/camera cuts.
    // A character in another location still counts when the narration actually
    // follows their current POV and shows active involvement in the player thread.
    for (const block of splitPresenceBlocks(text)) {
        const directPlayerScene = message?.is_user === true || hasDirectPlayerSceneAnchor(block, personaName);
        const playerReference = hasDirectPlayerReference(block, personaName);
        const surveillanceTarget = hasSurveillanceSceneTarget(block, personaName);

        for (const segment of splitEvidenceSegments(block)) {
            for (const variant of variants) {
                if (!nameAppears(segment, variant)) continue;
                let mode = findSubjectLinkedMode(segment, variant);
                if (mode === "unknown") continue;

                if (mode === "physical") {
                    if (!directPlayerScene) {
                        if (hasExplicitRemoteInfluence(block, variant, personaName)) {
                            mode = inferRemoteInfluenceMode(block, playerReference, surveillanceTarget);
                        } else if (message?.is_user !== true
                            && hasParallelNarrativeInvolvement(block, variant, personaName, messagePlayerReference)) {
                            mode = "parallel";
                        } else {
                            continue;
                        }
                    }
                } else if (mode === "call" || mode === "message") {
                    // A call/message with another NPC inside the character's own
                    // POV is parallel narrative involvement, not a live channel
                    // to the player. Keep call/message only when that channel is
                    // itself linked to the focal player.
                    if (!directPlayerScene) {
                        if (hasPlayerLinkedChannel(segment, block, personaName)) {
                            // keep the live channel mode
                        } else if (message?.is_user !== true
                            && hasParallelNarrativeInvolvement(block, variant, personaName, messagePlayerReference)) {
                            mode = "parallel";
                        } else {
                            continue;
                        }
                    }
                } else if (mode === "surveillance") {
                    if (!surveillanceTarget && !messagePlayerReference) continue;
                }

                if (mode === "physical" && isRemoteMode(lastMode) && !hasStrongPhysicalEntry(segment, variant)) continue;
                lastMode = mode;
            }
        }
    }
    return lastMode;
}

function findUnknownActiveMode(message, name, personaName = "") {
    const text = message?.mes || "";
    if (!text || isEmbeddedDocumentMessage(message, null)) return "unknown";
    const messagePlayerReference = hasDirectPlayerReference(text, personaName);
    let lastMode = "unknown";
    for (const block of splitPresenceBlocks(text)) {
        const directPlayerScene = message?.is_user === true || hasDirectPlayerSceneAnchor(block, personaName);
        const playerReference = hasDirectPlayerReference(block, personaName);
        const surveillanceTarget = hasSurveillanceSceneTarget(block, personaName);
        for (const segment of splitEvidenceSegments(block)) {
            if (!nameAppears(segment, name)) continue;
            let mode = findSubjectLinkedMode(segment, name);
            if (mode === "unknown") continue;
            if (mode === "physical" && !directPlayerScene) {
                if (message?.is_user !== true
                    && hasParallelNarrativeInvolvement(block, name, personaName, messagePlayerReference)) {
                    mode = "parallel";
                } else {
                    continue;
                }
            }
            if ((mode === "call" || mode === "message") && !directPlayerScene) {
                if (hasPlayerLinkedChannel(segment, block, personaName)) {
                    // keep live channel
                } else if (message?.is_user !== true
                    && hasParallelNarrativeInvolvement(block, name, personaName, messagePlayerReference)) {
                    mode = "parallel";
                } else {
                    continue;
                }
            }
            if (mode === "surveillance" && !surveillanceTarget && !messagePlayerReference) continue;
            if (mode === "physical" && isRemoteMode(lastMode) && !hasStrongPhysicalEntry(segment, name)) continue;
            lastMode = mode;
        }
    }
    return lastMode;
}

function splitPresenceBlocks(text) {
    return String(text || "")
        .split(/^\s*---+\s*$/gm)
        .map((block) => block.trim())
        .filter(Boolean);
}

function personaIdentityVariants(personaName) {
    const normalized = normalizeForMatch(personaName);
    if (!normalized) return [];
    const words = normalized.split(/\s+/).filter(Boolean);
    const variants = new Set([normalized]);
    if (words.length > 1) variants.add(words.at(-1));
    return [...variants];
}

function hasDirectPlayerReference(text, personaName) {
    const normalized = normalizeForMatch(text);
    if (!normalized) return false;
    if (/\b(?:you|your|yours|yourself)\b/i.test(normalized)) return true;
    return personaIdentityVariants(personaName).some((variant) => nameAppears(text, variant));
}

function hasDirectPlayerSceneAnchor(text, personaName) {
    // Ignore spoken/quoted material when deciding whether the prose camera is
    // physically with the user. Questions such as “did you sleep?” and generic
    // second-person phrasing inside an NPC's thoughts are not scene anchors.
    const proseOnly = String(text || "")
        .replace(/`[^`]*`/g, " ")
        .replace(/“[^”]*”|"[^"]*"/g, " ");
    const normalized = searchableText(proseOnly);
    if (!normalized) return false;

    const playerAction = /\byou\s+(?:stand|stood|sit|sat|walk|walked|look|looked|say|said|ask|asked|reach|reached|turn|turned|watch|watched|notice|noticed|arrive|arrived|enter|entered|leave|left|move|moved|lean|leaned|hold|held|take|took|keep|kept|remain|remained|stare|stared|wait|waited|open|opened|close|closed|pull|pulled|push|pushed|pick|picked|set|cross|crossed|follow|followed|breathe|breathed|cough|coughed)\b/i;
    const playerBodyOrPlace = /\byour\s+(?:hand|hands|face|eyes|body|voice|breathing|shoulder|shoulders|head|arm|arms|wrist|wrists|coat|hair|feet|foot|knee|knees|chest|stomach|side)\b/i;
    const directProximity = /\b(?:both of you|beside you|next to you|across from you|in front of you|behind you|toward you|with you)\b/i;
    if (playerAction.test(normalized) || playerBodyOrPlace.test(normalized) || directProximity.test(normalized)) return true;

    const physicalVerbs = "stood|sat|walked|looked|said|asked|replied|answered|slept|woke|entered|arrived|left|moved|turned|reached|held|took|waited|remained|coughed|breathed|nodded|smiled|frowned";
    for (const variant of personaIdentityVariants(personaName)) {
        const escaped = escapeRegExp(searchableText(variant)).replace(/ /g, "\\s+");
        if (!escaped) continue;
        if (new RegExp(`(?:^|\\b)${escaped}(?:'s)?\\b[^.!?]{0,45}\\b(?:${physicalVerbs})\\b`, "i").test(normalized)) return true;
    }
    return false;
}

function hasSurveillanceSceneTarget(text, personaName) {
    if (hasDirectPlayerReference(text, personaName)) return true;
    const normalized = normalizeForMatch(text);
    return /\b(?:subject|target|her apartment|his apartment|their apartment|apartment 4b)\b/i.test(normalized)
        && /\b(?:surveillance|observation|operative|camera|feed|monitor|tracking|report|dossier|intercept)\b/i.test(normalized);
}

function hasPlayerLinkedChannel(segment, block, personaName) {
    const segmentText = searchableText(segment);
    if (!segmentText) return false;
    const hasChannel = /\b(?:phone|call|line|speaker|speakerphone|radio|intercom|video call|text|message|chat|typing|voice)\b/i.test(segmentText);
    if (!hasChannel) return false;

    if (hasDirectPlayerReference(segment, personaName)) return true;
    if (/\bon the other end of (?:the )?(?:line|phone|call)\b/i.test(segmentText)
        && hasDirectPlayerReference(block, personaName)) {
        return true;
    }

    const normalizedBlock = searchableText(block);
    for (const variant of personaIdentityVariants(personaName)) {
        const needle = searchableText(variant);
        if (!needle) continue;
        const escaped = escapeRegExp(needle).replace(/ /g, "\\s+");
        const linked = new RegExp(
            `\\b(?:call|line|phone|speakerphone|video call|text|message)\\b[^.!?]{0,140}\\b${escaped}\\b|\\b${escaped}\\b[^.!?]{0,140}\\b(?:call|line|phone|speakerphone|video call|text|message)\\b`,
            "i",
        );
        if (linked.test(normalizedBlock)) return true;
    }
    return false;
}

function hasParallelNarrativeInvolvement(block, variant, personaName, messagePlayerReference = false) {
    const prose = String(block || "")
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`[^`]*`/g, " ")
        .replace(/^\s*>.*$/gm, " ");
    const text = searchableText(prose);
    const needle = searchableText(variant);
    if (!text || !needle || !nameAppears(prose, variant)) return false;

    // The parallel camera must still be connected to the player's current story
    // thread. A direct name/you reference is strongest; when the same assistant
    // message established that thread in another block, pronoun/target language
    // may carry the antecedent across the camera cut.
    const directPlayerReference = hasDirectPlayerReference(prose, personaName);
    const carriedPlayerReference = messagePlayerReference && /\b(?:her|him|them|the woman|the man|the girl|the guy|subject|target|civilian|sketch|drawing|dossier|profile|surveillance|case file|report)\b/i.test(text);
    if (!directPlayerReference && !carriedPlayerReference) return false;

    const escaped = escapeRegExp(needle).replace(/ /g, "\\s+");
    const activeVerbs = [
        "sat", "stood", "paced", "leaned", "waited", "remained", "stayed", "turned", "looked", "stared",
        "watched", "observed", "monitored", "tracked", "read", "reviewed", "studied", "examined", "scanned",
        "considered", "assessed", "evaluated", "reassessed", "thought", "wondered", "realized", "noticed", "noted",
        "decided", "resolved", "calculated", "planned", "ordered", "instructed", "directed", "commanded",
        "smirked", "smiled", "frowned", "scoffed", "laughed", "murmured", "said", "asked", "replied", "answered",
        "reached", "touched", "traced", "opened", "closed", "picked", "set", "lifted", "lowered", "held",
    ].join("|");
    const candidateHasAgency = new RegExp(
        `(?:^|\\b)${escaped}(?:'s)?\\b[^.!?]{0,100}\\b(?:${activeVerbs})\\b`,
        "i",
    ).test(text);
    if (!candidateHasAgency) return false;

    // A report saying what the character *did* elsewhere is still reference-only.
    // We need present-tense narrative camera/agency around them, not just an entry
    // whose subject happens to be their name.
    const reportFraming = /\b(?:report on|file on|dossier on|profile of|according to|the report (?:said|stated|noted)|was reported to have|had reportedly)\b/i.test(text);
    const currentCameraCue = /\b(?:office|headquarters|room|desk|window|corridor|hall|car|vehicle|apartment|garage|rooftop|street|building|floor|chair|sofa|table)\b/i.test(text)
        || /\b(?:now|currently|tonight|this morning|this afternoon|this evening|at that moment|for the moment)\b/i.test(text)
        || /^\s*\*[^*]{0,180}\b(?:sat|stood|paced|leaned|waited|remained|looked|watched|read|reviewed|studied)\b/i.test(block);

    return !reportFraming || currentCameraCue;
}

function hasExplicitRemoteInfluence(block, variant, personaName) {
    if (!hasDirectPlayerReference(block, personaName) && !hasSurveillanceSceneTarget(block, personaName)) return false;

    const blockText = searchableText(block);
    const needle = searchableText(variant);
    if (!blockText || !needle) return false;

    const hasSurveillanceContext = /\b(?:surveillance|observation|camera|feed|monitor|tracking|report|dossier|operative|subject|target|intercept|visitor log)\b/i.test(blockText);
    const hasCommunicationContext = /\b(?:call|line|speakerphone|radio|intercom|text|message|chat|typing|phone screen)\b/i.test(blockText);

    // Evaluate one sentence/action segment at a time. This keeps a name in one
    // paragraph from inheriting an unrelated action elsewhere in a long block.
    for (const segment of splitEvidenceSegments(block)) {
        if (!nameAppears(segment, variant)) continue;
        const text = searchableText(segment);
        if (!text) continue;
        const escaped = escapeRegExp(needle).replace(/ /g, "\\s+");

        const surveillanceAction = new RegExp(
            `\\b${escaped}(?:'s)?\\b[^.!?]{0,160}\\b(?:watched|observed|monitored|tracked|surveilled|reviewed|read|ordered|instructed|directed|intercepted)\\b`,
            "i",
        );
        if (hasSurveillanceContext && surveillanceAction.test(text)) return true;

        const communicationAction = new RegExp(
            `\\b${escaped}(?:'s)?\\b[^.!?]{0,120}\\b(?:called|dialed|texted|messaged|sent|replied|answered|listened)\\b`,
            "i",
        );
        if (hasCommunicationContext && communicationAction.test(text)) return true;
    }

    return false;
}

function inferRemoteInfluenceMode(block, playerReference, surveillanceTarget) {
    const text = normalizeForMatch(block);
    if (surveillanceTarget && /\b(?:surveillance|observation|camera|feed|monitor|tracking|report|dossier|operative|intercept)\b/i.test(text)) return "surveillance";
    if (playerReference && /\b(?:call|line|speakerphone|radio|intercom|voice came through|dialed|called)\b/i.test(text)) return "call";
    if (playerReference && /\b(?:text|message|chat|typing|phone screen)\b/i.test(text)) return "message";
    return "remote";
}

function hasStrongPhysicalEntry(segment, variant) {
    const text = searchableText(segment);
    const needle = searchableText(variant);
    if (!text || !needle) return false;
    const escaped = escapeRegExp(needle).replace(/ /g, "\\s+");
    const pattern = new RegExp(
        `\\b${escaped}\\b[^.!?]{0,70}\\b(?:arrived|entered|stepped (?:inside|in|through)|walked in|came in|appeared in the doorway|opened the door|took the stairs|crossed the threshold|sat beside|stood beside)\\b`,
        "i",
    );
    return pattern.test(text);
}

function findSubjectLinkedMode(segment, variant) {
    const text = searchableText(segment);
    const needle = searchableText(variant);
    if (!text || !needle) return "unknown";
    const escaped = escapeRegExp(needle).replace(/ /g, "\\s+");
    const index = text.indexOf(needle);
    if (index < 0) return "unknown";
    const local = text.slice(Math.max(0, index - 180), Math.min(text.length, index + needle.length + 220));

    const candidateIsReferenceObject = new RegExp(
        `\\b(?:report|file|dossier|profile|article|story|book|photo|picture)\\s+(?:about|on|of)\\s+(?:the\\s+)?(?:[a-z0-9'’.-]+\\s+){0,3}${escaped}\\b`,
        "i",
    ).test(local);
    if (candidateIsReferenceObject) return "unknown";

    // Explicitly reported/reference-only material is not live presence unless
    // the name itself is the grammatical subject of a live action below.
    const referenceOnly = hasReferenceOnlyCue(local);

    const nameThenCallAction = new RegExp(
        `\\b${escaped}(?:'s)?\\b[^.!?]{0,70}\\b(?:voice|answered|dialed|called|spoke|said|replied|breathed|went quiet)\\b`,
        "i",
    );
    const channelThenName = new RegExp(
        `\\b(?:through|over|on)\\s+the\\s+(?:phone|line|speaker|speakerphone|radio|intercom)[^.!?]{0,100}\\b${escaped}\\b`,
        "i",
    );
    if ((nameThenCallAction.test(local) || channelThenName.test(local))
        && /\b(?:phone|call|line|speaker|speakerphone|radio|intercom|voice)\b/i.test(local)) {
        return "call";
    }

    const nameThenSurveillanceAction = new RegExp(
        `\\b${escaped}\\b[^.!?]{0,80}\\b(?:watched|observed|monitored|tracked|reviewed|directed|ordered|instructed)\\b`,
        "i",
    );
    if (nameThenSurveillanceAction.test(local)
        && /\b(?:surveillance|camera|feed|monitor|observation|operative|report|tracking|dossier)\b/i.test(local)) {
        return "surveillance";
    }

    const nameThenMessageAction = new RegExp(
        `\\b${escaped}\\b[^.!?]{0,60}\\b(?:texted|messaged|typed|replied|responded)\\b`,
        "i",
    );
    if (nameThenMessageAction.test(local)
        && /\b(?:text|message|chat|typing|phone screen)\b/i.test(local)) {
        return "message";
    }

    const physicalVerbs = [
        "arrived", "entered", "stepped", "walked", "came", "stood", "sat", "crouched",
        "leaned", "approached", "reached", "grabbed", "held", "spoke", "said", "asked",
        "replied", "answered", "nodded", "smiled", "frowned", "laughed", "placed", "set",
        "followed", "waited", "remained", "stayed", "turned", "looked", "moved", "crossed",
        "took", "opened", "closed", "knelt", "rose", "paced", "padded", "slipped", "dropped",
        "lifted", "pulled", "pushed", "touched", "stared", "breathed", "sighed", "lay",
    ].join("|");
    const nameThenPhysicalAction = new RegExp(
        `\\b${escaped}\\b(?:\\s+(?:quietly|carefully|slowly|immediately|suddenly|still|then|just)){0,3}\\s+\\b(?:${physicalVerbs})\\b`,
        "i",
    );
    if (nameThenPhysicalAction.test(local) && !referenceOnly) return "physical";

    // Dialogue attribution can place the name after the verb.
    const dialogueAttribution = new RegExp(
        `\\b(?:said|asked|replied|answered|murmured|whispered|called)\\b[^.!?]{0,40}\\b${escaped}\\b`,
        "i",
    );
    if (dialogueAttribution.test(local) && !referenceOnly) {
        return /\b(?:phone|call|line|speaker|radio|intercom)\b/i.test(local) ? "call" : "physical";
    }

    return "unknown";
}

function hasLaterEndingEvidence(messages, activeIndex, candidate, mode, identityVariants, personaName = "") {
    for (let index = activeIndex + 1; index < messages.length; index++) {
        const message = messages[index];
        if (isEmbeddedDocumentMessage(message, messages[index - 1])) continue;
        if (mode === "physical" && isStrongSceneBoundary(message, messages[index - 1])) return true;
        const full = normalizeForMatch(message?.mes || "");
        if (mode === "call" && hasLiveChannelEndCue(full)) return true;

        const variants = identityVariants.get(candidate.profile.id) || [];
        for (const segment of splitEvidenceSegments(message?.mes || "")) {
            const normalized = normalizeForMatch(segment);
            if (!hasDepartureCue(normalized)) continue;
            if (variants.some((variant) => nameAppears(segment, variant))
                && hasSubjectLinkedDeparture(normalized, variants)) {
                return true;
            }
        }
    }
    return false;
}

function hasCandidateLinkedDeparture(messages, index, candidate, remoteCurrent, physicalCurrent, identityVariants) {
    const message = messages[index];
    const text = message?.mes || "";
    if (!text || isEmbeddedDocumentMessage(message, messages[index - 1])) return false;
    const variants = identityVariants.get(candidate.profile.id) || [];

    for (const segment of splitEvidenceSegments(text)) {
        const normalized = normalizeForMatch(segment);
        if (!hasDepartureCue(normalized)) continue;
        const named = variants.some((variant) => nameAppears(segment, variant));
        if (named && hasSubjectLinkedDeparture(normalized, variants)) return true;
    }

    const full = normalizeForMatch(text);
    if (hasLiveChannelEndCue(full)) {
        const mode = normalizeMode(candidate.currentMode);
        if (mode === "call") return true;
        if (isRemoteMode(mode) && isSoleRecentChannelParticipant(candidate, index, messages, remoteCurrent, identityVariants, "call")) return true;
    }
    if (!isRemoteMode(normalizeMode(candidate.currentMode)) && physicalCurrent.length === 1 && hasUnambiguousPronounDeparture(full)) {
        return true;
    }
    return false;
}

function isSoleRecentChannelParticipant(candidate, index, messages, remoteCurrent, identityVariants, channelMode) {
    const recentMatches = remoteCurrent.filter((current) => {
        const variants = identityVariants.get(current.profile.id) || [];
        for (let i = Math.max(0, index - 4); i < index; i++) {
            if (isEmbeddedDocumentMessage(messages[i], messages[i - 1])) continue;
            for (const segment of splitEvidenceSegments(messages[i]?.mes || "")) {
                if (!variants.some((variant) => nameAppears(segment, variant))) continue;
                if (findSubjectLinkedMode(segment, variants.find((variant) => nameAppears(segment, variant))) === channelMode) return true;
            }
        }
        return false;
    });
    return recentMatches.length === 1 && recentMatches[0].profile.id === candidate.profile.id;
}

function hasSubjectLinkedDeparture(segment, variants) {
    const searchable = searchableText(segment);
    if (!searchable) return false;
    for (const variant of variants) {
        const needle = searchableText(variant);
        if (!needle) continue;
        const escaped = escapeRegExp(needle).replace(/ /g, "\\s+");
        const subjectThenExit = new RegExp(
            `(?:^|\\b)${escaped}(?:'s)?\\b[^.!?]{0,120}\\b(?:left|departed|exited|walked away|drove away|went home|returned home|hung up|disconnected|ended (?:the )?call|closed the connection|signed off|said goodbye|bid [^.!?]{0,30} goodbye)\\b`,
            "i",
        );
        if (subjectThenExit.test(searchable)) return true;
    }
    return false;
}

function hasDepartureCue(text) {
    if (!text) return false;
    return /\b(?:departed|exited|walked away|drove away|went home|returned home|hung up|disconnected|ended the call|call ended|line went dead|connection closed|signed off|said goodbye|bid [^.!?]{0,30} goodbye)\b/i.test(text)
        || /\b(?:he|she|they) left\b(?!\s+(?:hand|arm|leg|eye|side|pocket|shoe|door|window|note|message|book|phone))/i.test(text);
}

function hasLiveChannelEndCue(text) {
    return /\b(?:the )?(?:call|line|connection|video feed|audio feed|surveillance feed)\s+(?:ended|disconnected|went dead|cut out|closed)\b/i.test(text)
        || /\b(?:hung up|ended the call|closed the connection|signed off)\b/i.test(text);
}

function hasUnambiguousPronounDeparture(text) {
    return /\b(?:he|she|they)\s+(?:left|departed|exited|walked away|drove away|went home|returned home|said goodbye)\b/i.test(text);
}

function inferModeFromSegment(text) {
    if (!text) return "unknown";
    if (/\b(?:phone|call|line|speakerphone|earpiece|video call|radio|intercom|over the phone|through the phone|voice came through|voice crackled|line clicked open)\b/i.test(text)) {
        return "call";
    }
    if (/\b(?:surveillance|camera feed|video feed|audio feed|monitor(?:ed|ing)?|watching remotely|observation log|operative logged|live feed)\b/i.test(text)) {
        return "surveillance";
    }
    if (/\b(?:live message|texted|messaged|chat window|typing indicator|message exchange|replied by text)\b/i.test(text)) {
        return "message";
    }
    if (/\b(?:arrived|entered|stepped inside|stepped in|walked in|came in|appeared in the doorway|opened the door|stood|sat|seated|leaned|approached|crossed the room|looked|turned|reached|grabbed|held|spoke|said|asked|replied|answered|nodded|smiled|frowned|laughed|placed|set down|followed|waited|remained beside|stayed beside)\b/i.test(text)) {
        return "physical";
    }
    return "unknown";
}

function hasReferenceOnlyCue(text) {
    if (!text) return false;
    return /\b(?:might|may|could|would|will|going to|plans? to|planned to|expected to|supposed to|tomorrow|later today|later tonight|next week|if|whether)\b/i.test(text)
        || /\b(?:remembered|recalled|thought about|thought of|dreamed of|mentioned|talked about|heard about|asked about|told .* about|report on|file on|dossier on|photo of|picture of|message from|letter from|birthday|funeral|anniversary)\b/i.test(text)
        || /\b(?:yesterday|earlier that day|last night|last week|years ago|had visited|had called|had said|used to)\b/i.test(text);
}

// ─── Scene and Embedded-Content Detection ─────────────────

function isEmbeddedDocumentMessage(message, previousMessage) {
    const raw = String(message?.mes || "").trimStart();
    if (!raw) return false;
    if (/^```/.test(raw)) return true;
    if (/^(?:---+\s*\n+)?\s*#{1,6}\s+[^\n]+/.test(raw)) return true;

    const previous = normalizeForMatch(previousMessage?.mes || "");
    if (/\b(?:read|reading|chapter|novel|book|article|post|document|report|letter|message)\b/i.test(previous)
        && /^(?:#{1,6}\s|>(?:.|\n){20,})/.test(raw)) {
        return true;
    }
    return false;
}

function isStrongSceneBoundary(message, previousMessage) {
    const raw = String(message?.mes || "").trimStart();
    if (!raw || isEmbeddedDocumentMessage(message, previousMessage)) return false;
    const first = normalizeForMatch(raw.slice(0, 420));

    if (/^---+\s*(?!#)/.test(raw)) return true;
    return /^(?:hours?|days?|weeks?|months?) later\b/i.test(first)
        || /^(?:the )?next (?:morning|afternoon|evening|night|day)\b/i.test(first)
        || /^the following (?:morning|afternoon|evening|night|day)\b/i.test(first)
        || /^later (?:that|the same) (?:morning|afternoon|evening|night|day)\b/i.test(first)
        || /^meanwhile(?:,|\s)+(?:elsewhere|at|in)\b/i.test(first)
        || /^elsewhere(?:,|\s)+(?:at|in)\b/i.test(first)
        || /^back (?:at|in)\s+[\p{L}\p{N}]/iu.test(first)
        || /^upon arriving\b/i.test(first)
        || /^by the time\b/i.test(first);
}

// ─── Name Matching ────────────────────────────────────────

function getCurrentCanonicalNames(allCharacters) {
    const currentIds = new Set(getPresentCharacters());
    return allCharacters.filter((profile) => currentIds.has(profile.id)).map((profile) => profile.name);
}

function getCurrentCanonicalModes(allCharacters) {
    const currentIds = new Set(getPresentCharacters());
    const storedModes = getPresenceModes();
    return Object.fromEntries(
        allCharacters
            .filter((profile) => currentIds.has(profile.id))
            .map((profile) => [profile.name, normalizeMode(storedModes?.[profile.id])]),
    );
}

function normalizeMode(value) {
    const mode = String(value || "").toLowerCase().trim().replace(/[\s-]+/g, "_");
    if (mode === "physical") return "physical";
    if (mode === "call" || mode === "live_call" || mode === "remote_call" || mode === "phone") return "call";
    if (mode === "surveillance" || mode === "remote_surveillance" || mode === "live_surveillance") return "surveillance";
    if (mode === "message" || mode === "live_message" || mode === "remote_message" || mode === "text") return "message";
    if (mode === "remote") return "remote";
    if (mode === "parallel" || mode === "parallel_scene" || mode === "parallel_pov") return "parallel";
    return "unknown";
}

function isRemoteMode(mode) {
    return mode === "call" || mode === "surveillance" || mode === "message" || mode === "remote" || mode === "parallel";
}

function normalizeForMatch(value) {
    return String(value || "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[’‘`]/g, "'")
        .replace(/[‐‑‒–—−]/g, "-")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}

function searchableText(value) {
    return normalizeForMatch(value)
        .replace(/[^\p{L}\p{N}'-]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function nameAppears(text, variant) {
    const haystack = searchableText(text);
    const needle = searchableText(variant);
    if (!haystack || !needle) return false;
    if (containsCJK(needle)) return haystack.includes(needle);
    const escaped = escapeRegExp(needle).replace(/ /g, "\\s+");
    return new RegExp(`(?:^|\\s)${escaped}(?:'s)?(?=\\s|$)`, "i").test(haystack);
}

function containsCJK(value) {
    return /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/u.test(value);
}

function looksLikeProperName(name) {
    const normalized = normalizeForMatch(name);
    if (!normalized || normalized.length < 2 || normalized.length > 60) return false;
    if (GENERIC_UNKNOWN_NAMES.has(normalized)) return false;
    const words = normalized.split(/\s+/).filter(Boolean);
    if (words.length > 6) return false;
    if (/\b(the|a|an|this|that|someone|somebody|unknown|narrator|assistant|system)\b/i.test(normalized)) return false;
    return /^[\p{L}\p{M}][\p{L}\p{M}'’.-]*(?:\s+[\p{L}\p{M}][\p{L}\p{M}'’.-]*)*$/u.test(name.trim());
}

function splitEvidenceSegments(text) {
    return String(text || "")
        .split(/(?<=[.!?])\s+|\n{2,}/)
        .map((segment) => segment.trim())
        .filter(Boolean);
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncateMessage(text) {
    const value = String(text || "");
    if (value.length <= MAX_MESSAGE_CHARS) return value;
    const head = Math.floor(MAX_MESSAGE_CHARS * 0.5);
    const tail = MAX_MESSAGE_CHARS - head;
    return `${value.slice(0, head)}\n…[middle truncated]…\n${value.slice(-tail)}`;
}

function getRecentMessages(count) {
    if (!chat || !Array.isArray(chat)) return [];
    const visibleMessages = chat.filter((message) => !message.is_system);
    return visibleMessages.slice(-count);
}
