/** Shared, dependency-free identity normalization for blacklist and character resolution. */
export function normalizeNameForMatch(name) {
    return String(name || "")
        .normalize("NFKD")
        .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
        .normalize("NFKC")
        .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, "-")
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^[\s"'`*_.,;:!?()[\]{}<>]+|[\s"'`*_.,;:!?()[\]{}<>]+$/g, "")
        .toLowerCase();
}

export function getNameMatchKeys(name) {
    const normalized = normalizeNameForMatch(name);
    if (!normalized) return [];
    const compact = normalized.replace(/[\s._'`-]+/g, "");
    return [...new Set([normalized, compact].filter(Boolean))];
}

export function getNameWordSignature(name) {
    return normalizeNameForMatch(name).split(/\s+/).filter(Boolean).sort().join(" ");
}

export function getNameTokens(name) {
    return normalizeNameForMatch(name).split(/[\s._'`-]+/).filter(Boolean);
}
