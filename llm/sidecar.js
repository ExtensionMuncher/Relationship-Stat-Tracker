/**
 * sidecar.js — Sidecar LLM: character presence detection
 * Calls a lightweight LLM to detect character names in recent messages
 */

import { chat } from "../../../../../script.js";
import { getContext } from "../../../../extensions.js";
import { makeRequest } from "./connections.js";
import { getSettings, getNameBlacklist } from "../data/storage.js";
import { getAllCharacters, getCharacterNameVariants, findCharacterByFuzzyName } from "../data/characters.js";

// ─── Sidecar Detection ────────────────────────────────────

/**
 * Run sidecar detection on recent messages.
 * @param {number} [messageCount=10] - How many recent messages to scan
 * @returns {Promise<{detected: string[], unknown: string[]}>} detected = known names, unknown = new names
 */
export async function detectCharacters(messageCount = null) {
    const settings = getSettings();
    if (!settings.enabled) return { detected: [], unknown: [] };

    const profileName = settings.connections.sidecarLLM;
    const count = messageCount ?? (settings.messagesToScan || 10);
    const messages = getRecentMessages(count);

    if (messages.length === 0) return { detected: [], unknown: [] };

    const knownCharacters = getAllCharacters();
    const knownNames = knownCharacters.map((c) => c.name);

    const systemPrompt = buildSidecarSystemPrompt();
    const requestPrompt = buildSidecarRequestPrompt(messages, knownNames);

    console.log("[RST] detectCharacters: using profile=" + profileName + ", messages=" + messages.length + ", knownNames=" + knownNames.length);

    try {
        const result = await makeRequest(
            profileName,
            systemPrompt,
            requestPrompt,
            3000,
        );

        console.log("[RST] detectCharacters: LLM response received, len=" + (result ? result.length : 0) + ", preview=" + (result ? result.substring(0, 200) : "null"));

        if (!result) return { detected: [], unknown: [] };

        const detectedNames = parseDetectedNames(result);
        console.log("[RST] detectCharacters: parsed names:", JSON.stringify(detectedNames));

        // ── Post-filter: verify names against actual message content ──
        // LLMs often include characters who are only mentioned or described
        // by narration. This filter keeps only characters who actually SPEAK
        // or are directly addressed in the scanned messages.
        const verifiedNames = filterByMessagePresence(detectedNames, messages);
        const removedNames = detectedNames.filter(n => !verifiedNames.includes(n));
        if (removedNames.length > 0) {
            console.log("[RST] detectCharacters: post-filter removed (mentioned-only or narration-only):", JSON.stringify(removedNames));
        }
        console.log("[RST] detectCharacters: post-filter kept:", JSON.stringify(verifiedNames));

        return categorizeNames(verifiedNames, knownNames);
    } catch (err) {
        console.error("[RST] Sidecar detection failed:", err);
        toastr?.error?.("Sidecar character detection failed. Check your connection settings.");
        return { detected: [], unknown: [] };
    }
}

// ─── Prompt Building ──────────────────────────────────────

/**
 * Build the system prompt for the sidecar LLM.
 * @param {string[]} knownNames - Already-known character names
 * @returns {string}
 */
function buildSidecarSystemPrompt() {
    return [
        'You are a character name detection assistant. Identify all character names mentioned in chat messages.',
        'CRITICAL RULES:',
        '- Do NOT include any thinking, reasoning, analysis, chain-of-thought, or commentary.',
        '- Do NOT output markdown headings, bullet points, or numbered steps.',
        '- Output ONLY a valid JSON array of name strings. Nothing else. Not even a single character outside the JSON.',
        '- Example correct output: ["Alice","Bob"]',
    ].join('\n');
}

/**
 * Build the request prompt with recent messages.
 * @param {Array} messages
 * @returns {string}
 */
function buildSidecarRequestPrompt(messages, knownNames) {
    const lines = messages.map((m, i) => {
        const speaker = m.name || "Unknown";
        const text = (m.mes || "").slice(0, 500);
        return `[${i}] ${speaker}: ${text}`;
    });

    const parts = [
        'Identify ONLY characters who are PHYSICALLY PRESENT and actively participating in the CURRENT scene — not characters in other locations or timeframes.',
        '',
        'STRICT INCLUSION RULES (ALL must be true):',
        '- The character must actually SPEAK dialogue in these messages (appear as a message speaker), OR be directly addressed BY NAME in dialogue by another character.',
        '- The character must be in the SAME physical location/scene as the other characters, not in a different place.',
        '',
        'STRICT EXCLUSION RULES:',
        '- EXCLUDE characters who are in a DIFFERENT LOCATION (separate scene, different building, different part of the city).',
        '- EXCLUDE characters who are only MENTIONED or REFERENCED in conversation (e.g., "I talked with [Name] yesterday" — EXCLUDE [Name]).',
        '- EXCLUDE characters who are only DESCRIBED by narration, surveillance logs, or internal reports but do not speak or get addressed.',
        '- EXCLUDE characters appearing in flashbacks, memories, or hypothetical scenarios.',
        '- EXCLUDE the user/player character name.',
        '- EXCLUDE generic titles (like "the man", "a woman").',
        '- CRITICAL: If a character is merely being talked ABOUT, EXCLUDE them. They must be ACTIVELY PARTICIPATING.',
        '- Each name should appear only once.',
    ];

    if (knownNames.length > 0) {
        parts.push(`- Already-known characters (include if present): ${knownNames.join(", ")}`);
    }

    parts.push('');
    parts.push(...lines);

    return parts.join('\n');
}

// ─── Response Parsing ─────────────────────────────────────

/**
 * Parse the LLM response into an array of names.
 * Tries multiple parsing strategies in order of reliability.
 * Robust against thinking/reasoning models that emit prose alongside JSON.
 * @param {string} response - Raw LLM output
 * @returns {string[]} Detected character names
 */
function parseDetectedNames(response) {
    if (!response || typeof response !== "string") return [];

    const raw = response.trim();

    console.log("[RST] parseDetectedNames: input len=" + raw.length + " preview=" + raw.substring(0, 250));

    // ── Guard: if the entire response is clearly thinking prose with no JSON,
    //    skip the line-based fallback. JSON extraction strategies are still tried,
    //    but Strategy 3 (comma-split) NEVER runs on prose — it would extract
    //    garbage from reasoning text including the prompt's known-character list.
    const startsLikeJSON = /^\s*[\[{]/.test(raw);
    const looksLikePureProse = !startsLikeJSON && (
        // Multiple markdown-style headings
        (raw.match(/^#+\s+/gm) || []).length >= 2 ||
        // Numbered list with bold markers (thinking model step-by-step)
        /^\d+\.\s+\*\*/m.test(raw) ||
        // Thinking/reasoning preamble phrases
        /^(Here'?s?\s+a?\s+thinking|Let me|I (?:need|will|should|must|can)|First[,\s]|The user |Okay[,.]?\s+(?:let|so|the)|Following\s+the\s+rules|Name detection|Step\s*\d|Analysis|Reasoning|Thinking)/i.test(raw) ||
        // Multiple numbered steps (3+) — strong signal of reasoning/analysis
        (raw.match(/^\d+\.\s/mg) || []).length >= 3 ||
        // Numbered rule/instruction list (models echo the prompt rules)
        /^\d+\.\s+(?:No|Do|Include|Exclude|Output|Identify|Each|Analyze|Review|Scan|Compile)/m.test(raw) ||
        // Multiple markdown bold sections (common in reasoning)
        (raw.match(/\*\*[^*]+\*\*/g) || []).length >= 2
    );
    console.log("[RST] parseDetectedNames: startsLikeJSON=" + startsLikeJSON + " looksLikePureProse=" + looksLikePureProse +
        " headingCount=" + ((raw.match(/^#+\s+/gm) || []).length) +
        " hasNumberedBold=" + /^\d+\.\s+\*\*/m.test(raw) +
        " numberedStepCount=" + ((raw.match(/^\d+\.\s/mg) || []).length) +
        " boldSectionCount=" + ((raw.match(/\*\*[^*]+\*\*/g) || []).length));
    if (looksLikePureProse) {
        console.log("[RST] parseDetectedNames: response looks like pure thinking prose, will skip line-based fallback if no JSON found");
    }

    // ── Strategy 0: Try the raw response as JSON first (before stripping fences) ──
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            console.log("[RST] parseDetectedNames: Strategy 0 (raw JSON.parse) SUCCESS, count=" + parsed.length);
            return parsed.filter((n) => typeof n === "string" && n.trim().length > 0);
        }
    } catch {
        // Continue
    }

    // Strip markdown code fences (```json ... ``` or ``` ... ```)
    let cleaned = raw
        .replace(/```(?:json)?\s*/gi, "")
        .replace(/\s*```/g, "")
        .trim();

    // Strategy 1: Try direct JSON.parse on the cleaned response
    try {
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed)) {
            console.log("[RST] parseDetectedNames: Strategy 1 (cleaned JSON.parse) SUCCESS, count=" + parsed.length);
            return parsed.filter((n) => typeof n === "string" && n.trim().length > 0);
        }
    } catch {
        // Continue to next strategy
    }

    // Strategy 2: Try greedy regex to find the outermost JSON array
    // Uses greedy * instead of non-greedy *? to capture the FULL array
    // (including nested brackets or multi-line content)
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
        try {
            const parsed = JSON.parse(arrayMatch[0]);
            if (Array.isArray(parsed)) {
                console.log("[RST] parseDetectedNames: Strategy 2 (greedy regex on cleaned) SUCCESS, count=" + parsed.length);
                return parsed.filter((n) => typeof n === "string" && n.trim().length > 0);
            }
        } catch {
            // Continue to next strategy
        }

        // Strategy 2b: If outermost match failed, try each inner array individually
        // (handles cases where the LLM outputs multiple separate arrays)
        const innerMatches = cleaned.matchAll(/\[[\s\S]*?\]/g);
        const allNames = [];
        for (const m of innerMatches) {
            try {
                const parsed = JSON.parse(m[0]);
                if (Array.isArray(parsed)) {
                    for (const n of parsed) {
                        if (typeof n === "string" && n.trim().length > 0) {
                            allNames.push(n.trim());
                        }
                    }
                }
            } catch {
                // Skip malformed inner arrays
            }
        }
        if (allNames.length > 0) {
            // Deduplicate while preserving order
            const deduped = [...new Set(allNames)];
            console.log("[RST] parseDetectedNames: Strategy 2b (inner arrays) SUCCESS, count=" + deduped.length);
            return deduped;
        }
    }

    // Strategy 2c: Try the raw (uncleaned) response for JSON arrays — sometimes
    // the cleaning strips essential structure from code-fenced JSON in prose.
    if (raw !== cleaned) {
        const rawArrayMatch = raw.match(/\[[\s\S]*\]/);
        if (rawArrayMatch) {
            try {
                const parsed = JSON.parse(rawArrayMatch[0]);
                if (Array.isArray(parsed)) {
                    console.log("[RST] parseDetectedNames: Strategy 2c (raw greedy regex) SUCCESS, count=" + parsed.length);
                    return parsed.filter((n) => typeof n === "string" && n.trim().length > 0);
                }
            } catch {
                // Continue
            }
        }
    }

    // ── If the response looks like pure thinking prose, return empty ──
    // (don't fall through to the line-based fallback which would extract garbage)
    if (looksLikePureProse) {
        console.log("[RST] parseDetectedNames: no JSON found in thinking prose, returning empty");
        return [];
    }

    // Strategy 3: Line-based fallback with strict filtering
    // Only use this if all JSON strategies failed
    console.log("[RST] parseDetectedNames: WARNING — falling through to Strategy 3 (line-based fallback)");
    const fallbackResult = cleaned
        .split(/[,|\n]+/)
        .map((s) => s.trim().replace(/^["'\d.\s]+/, "").replace(/["']$/, "").trim())
        .filter((s) => {
            if (s.length === 0 || s.length >= 50) return false;
            // Reject strings that look like JSON fragments, markdown artifacts, or noise
            if (/^[\[\]{}"':;,.!?\-_#$%^&*()+=\/\\<>]+$/.test(s)) return false;
            // Reject purely numeric strings
            if (/^\d+$/.test(s)) return false;
            // Reject single characters that aren't valid names
            if (s.length === 1 && !/^[A-Za-z]$/.test(s)) return false;
            // Reject markdown heading/bold artifacts
            if (/^\*+$/.test(s)) return false;
            if (/^\*+\s/.test(s)) return false;
            // Reject fragments that are clearly English prose (contain spaces + common words)
            if (/\s(the|and|or|for|are|was|has|with|that|this|from|they|have|been)\s/i.test(s)) return false;
            // Reject strings that look like prompt instruction fragments
            if (/^(include|exclude|identify|critical|important|already-known|known characters)/i.test(s)) return false;
            return true;
        });
    console.log("[RST] parseDetectedNames: Strategy 3 result count=" + fallbackResult.length);
    return fallbackResult;
}

/**
 * Categorize detected names into known and unknown.
 * Filters out blacklisted names (from settings) and persona/user names.
 * @param {string[]} detectedNames
 * @param {string[]} knownNames
 * @returns {{detected: string[], unknown: string[]}}
 */
function categorizeNames(detectedNames, knownNames) {
    const allCharacters = getAllCharacters();

    // Build exclusion set: persona name + settings blacklist + hardcoded placeholders
    const settings = getSettings();
    const personaName = (getContext().name1 || "").toLowerCase().trim();
    const blacklistNames = (getNameBlacklist() || []).map((n) => n.toLowerCase().trim()).filter(Boolean);
    const excludedNames = new Set(["{{user}}", "user", "User", personaName, ...blacklistNames]);

    // Helper: check if a name should be excluded
    function isExcluded(name) {
        const n = (name || "").toLowerCase().trim();
        return !n || excludedNames.has(n);
    }

    // Build a flat map: every known name variant → character profile
    const knownVariants = new Map(); // lowercased variant name → character
    for (const char of allCharacters) {
        const variants = getCharacterNameVariants(char);
        for (const v of variants) {
            if (!knownVariants.has(v)) {
                knownVariants.set(v, char);
            }
        }
    }

    const detected = [];
    const unknown = [];

    for (const name of detectedNames) {
        if (isExcluded(name)) continue;
        const nameLower = name.toLowerCase().trim();
        if (!nameLower) continue;

        // 1. Exact match against any variant (main name or alias)
        const exactChar = knownVariants.get(nameLower);
        if (exactChar) {
            detected.push(exactChar.name);
            continue;
        }

        // 2. Fuzzy match (word-set + substring) against all character profiles
        const fuzzyChar = findCharacterByFuzzyName(name);
        if (fuzzyChar) {
            detected.push(fuzzyChar.name);
            continue;
        }

        // 3. No match found — truly unknown
        unknown.push(name);
    }

    return { detected, unknown };
}

// ─── Helpers ──────────────────────────────────────────────

/**
 * Post-filter: remove names that don't appear as speakers or aren't directly
 * addressed in the scanned messages. This prevents the LLM from including
 * characters who are only described by narration, surveillance logs, or
 * mentioned in passing.
 *
 * @param {string[]} names - Raw detected names from the LLM
 * @param {Array} messages - The scanned chat messages
 * @returns {string[]} Filtered names
 */
function filterByMessagePresence(names, messages) {
    if (!names.length || !messages.length) return names;

    // Collect speaker names (lowercased for comparison)
    const speakerSet = new Set();
    for (const m of messages) {
        if (m.name) speakerSet.add(m.name.toLowerCase().trim());
    }

    // Collect all message text from named speakers (exclude system/narrator)
    // for direct-address checking
    const dialogueTexts = [];
    for (const m of messages) {
        if (m.name && m.name !== "System" && m.name !== "Narrator" && m.mes) {
            dialogueTexts.push(m.mes.toLowerCase());
        }
    }
    const allDialogue = dialogueTexts.join(" ");

    return names.filter(name => {
        if (!name || !name.trim()) return false;
        const nameLower = name.toLowerCase().trim();

        // 1. Is this character a message speaker?
        if (speakerSet.has(nameLower)) return true;

        // 2. Is this character directly addressed by name in dialogue?
        // Check for common Japanese and English address patterns
        const nameParts = nameLower.split(/\s+/);
        for (const part of nameParts) {
            if (part.length < 3) continue; // skip short fragments
            const escaped = part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const patterns = [
                // Japanese honorifics: Name-san, Name-kun, Name-chan, etc.
                new RegExp('\\b' + escaped + '[-\\s]?(?:san|kun|chan|sama|sensei|senpai|dono|tan|氏)', 'i'),
                // Direct address: "Hey Name", "Name, ...", "Name!"
                new RegExp('\\b(?:hey|hi|hello|yo|oi|ah|oh)\\s+' + escaped + '\\b', 'i'),
                new RegExp('\\b' + escaped + '[,!.:;]', 'i'),
                // Japanese address: "Nameさん", "Nameくん"
                new RegExp(escaped + '[\\u3000-\\u303F\\u3040-\\u309F\\u30A0-\\u30FF]', 'i'),
            ];
            for (const pat of patterns) {
                if (pat.test(allDialogue)) return true;
            }
        }

        return false;
    });
}

/**
 * Get the N most recent chat messages.
 * @param {number} count
 * @returns {Array}
 */
function getRecentMessages(count) {
    if (!chat || !Array.isArray(chat)) return [];

    // Filter out ST-hidden messages (is_system=true) to only scan visible chat,
    // mirroring how ST's Generate() builds coreChat = chat.filter(x => !x.is_system ...)
    const visibleMessages = chat.filter((m) => !m.is_system);
    return visibleMessages.slice(-count);
}
