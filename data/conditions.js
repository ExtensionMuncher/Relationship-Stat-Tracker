/**
 * conditions.js — Fixed catalog for temporary relationship conditions.
 * Conditions are contextual lenses, not permanent stats or personality traits.
 */

export const MAX_ACTIVE_RELATIONSHIP_CONDITIONS = 4;
export const MAX_NEW_CONDITIONS_PER_UPDATE = 1;

export const RELATIONSHIP_CONDITION_CATALOG = {
    guarded: {
        label: "Guarded", icon: "fa-shield",
        meaning: "The character is deliberately limiting emotional access or trust.",
        effect: "Positive trust/openness evidence must be especially clear and personally relevant; ordinary warmth should not rapidly soften established defenses.",
    },
    suspicious: {
        label: "Suspicious", icon: "fa-eye",
        meaning: "The character is actively questioning motives, honesty, or hidden risk.",
        effect: "Ambiguous behavior should not increase trust; contradictions, secrecy, or evasiveness carry extra relational weight.",
    },
    resentful: {
        label: "Resentful", icon: "fa-fire",
        meaning: "An unresolved grievance is coloring how the character interprets the relationship.",
        effect: "Positive gestures may be discounted until the underlying grievance is acknowledged or meaningfully repaired.",
    },
    avoidant: {
        label: "Avoidant", icon: "fa-person-walking",
        meaning: "The character is actively creating emotional or interpersonal distance.",
        effect: "Reduced contact is not automatically reduced affection; openness and reliance require stronger evidence while distancing persists.",
    },
    defensive: {
        label: "Defensive", icon: "fa-shield-halved",
        meaning: "The character is protecting their self-image, boundaries, or vulnerabilities from perceived pressure.",
        effect: "Pressure, confrontation, or invasive intimacy may reduce openness even when affection remains intact.",
    },
    withdrawn: {
        label: "Emotionally Withdrawn", icon: "fa-cloud",
        meaning: "The character has pulled inward and is limiting emotional engagement.",
        effect: "Low expressiveness should not be mistaken for indifference; require explicit evidence before moving affection or trust sharply.",
    },
    betrayed: {
        label: "Betrayed", icon: "fa-heart-crack",
        meaning: "The character believes a meaningful bond, promise, or expectation was violated.",
        effect: "Trust recovery should be slow and evidence-heavy even if affection remains high.",
    },
    humiliated: {
        label: "Humiliated", icon: "fa-face-flushed",
        meaning: "The character feels exposed, diminished, or publicly shamed by the relationship context.",
        effect: "Pride, defensiveness, anger, or withdrawal may temporarily dominate otherwise positive feelings.",
    },
    threatened: {
        label: "Threatened", icon: "fa-triangle-exclamation",
        meaning: "The character currently perceives the user or relationship as a meaningful threat to safety, status, control, or identity.",
        effect: "Trust/support gains require direct evidence of safety; controlling or hostile responses may be self-protective rather than evidence of low affection.",
    },
    protective: {
        label: "Protective", icon: "fa-shield-heart",
        meaning: "The character feels an active need to safeguard the user or the bond.",
        effect: "Protective behavior may support affection/support, but possessive protection must not be mistaken for trust or healthy openness.",
    },
    grateful: {
        label: "Grateful", icon: "fa-hand-holding-heart",
        meaning: "The character is carrying meaningful gratitude toward the user.",
        effect: "Supportive or affiliative movement is more plausible, but gratitude alone does not establish trust, intimacy, or romance.",
    },
    hopeful: {
        label: "Hopeful", icon: "fa-sun",
        meaning: "The character currently believes the relationship may improve or become something they value.",
        effect: "Repair attempts and reciprocal vulnerability can matter more, while setbacks may feel disproportionately discouraging.",
    },
    reassured: {
        label: "Reassured", icon: "fa-circle-check",
        meaning: "A recent uncertainty or fear has been meaningfully eased.",
        effect: "Trust/openness may resume ordinary movement, but reassurance is not itself proof that deeper structural barriers are gone.",
    },
    fascinated: {
        label: "Fascinated", icon: "fa-star",
        meaning: "The character is unusually attentive to, curious about, or mentally occupied by the user.",
        effect: "Attention and affection may rise without corresponding trust, support, or emotional openness.",
    },
    infatuated: {
        label: "Infatuated", icon: "fa-heart",
        meaning: "The character is experiencing heightened romantic or physical preoccupation.",
        effect: "Affection can be especially reactive, but infatuation must not automatically inflate trust, support, or mature intimacy.",
    },
    vulnerable: {
        label: "Emotionally Vulnerable", icon: "fa-heart-circle-exclamation",
        meaning: "The character is unusually exposed emotionally and sensitive to the user's response.",
        effect: "Respectful handling of vulnerability can matter strongly; exploitation, dismissal, or ridicule can cause disproportionate damage.",
    },
    reliant: {
        label: "Reliant", icon: "fa-link",
        meaning: "The character is currently depending on the user in a meaningful way.",
        effect: "Follow-through and reliability are especially relevant to trust/support; dependence alone does not equal affection.",
    },
    newly_trusting: {
        label: "Newly Trusting", icon: "fa-handshake",
        meaning: "The character has recently begun extending trust that was previously withheld.",
        effect: "Consistency matters more than intensity; one impressive gesture should not instantly convert tentative trust into deep trust.",
    },
    conflicted: {
        label: "Conflicted", icon: "fa-scale-balanced",
        meaning: "Strong competing feelings or values are pulling the character in different directions.",
        effect: "Opposing stat movement across categories is plausible; avoid forcing the relationship into a single positive or negative interpretation.",
    },
    jealous: {
        label: "Jealous", icon: "fa-eye",
        meaning: "The character feels threatened by perceived relational competition or displacement.",
        effect: "Jealousy may intensify attention, possessiveness, or affection while simultaneously damaging trust/support; do not treat it as inherently romantic progress.",
    },
    possessive: {
        label: "Possessive", icon: "fa-lock",
        meaning: "The character is treating access to the user or bond as something they should control or own.",
        effect: "Possessiveness may coexist with strong affection while reinforcing distrust, poor support, or limited openness.",
    },
    guilty: {
        label: "Guilty", icon: "fa-weight-hanging",
        meaning: "The character feels responsible for harm, failure, or wrongdoing affecting the user or relationship.",
        effect: "Supportive behavior may be reparative rather than evidence of secure affection; openness may increase if guilt is honestly acknowledged.",
    },
    grieving: {
        label: "Grieving", icon: "fa-ribbon",
        meaning: "Grief is materially affecting the character's emotional availability and interpretation of the relationship.",
        effect: "Withdrawal, volatility, or unusual reliance may reflect grief rather than a stable change in underlying affection or trust.",
    },
    anxious: {
        label: "Anxious", icon: "fa-heart-pulse",
        meaning: "The character is experiencing heightened relational uncertainty or fear.",
        effect: "Reassurance, consistency, and perceived rejection carry extra weight; anxiety should not be confused with low trust by itself.",
    },
    obsessive: {
        label: "Obsessive", icon: "fa-bullseye",
        meaning: "The character's attention to the user has become unusually persistent or consuming.",
        effect: "Affection/attention may intensify without healthy trust, openness, or support; obsession must never be treated as proof of relational security.",
    },
    disillusioned: {
        label: "Disillusioned", icon: "fa-heart-crack",
        meaning: "An idealized or previously favorable view of the user or relationship has been meaningfully damaged.",
        effect: "Positive evidence may be scrutinized more harshly until the character forms a new, more realistic interpretation of the bond.",
    },
    testing_boundaries: {
        label: "Testing Boundaries", icon: "fa-ruler",
        meaning: "The character is actively probing what the user will tolerate, enforce, or reciprocate.",
        effect: "Boundary respect and consistency matter more than charm or intensity; repeated violations should weigh heavily against trust/support.",
    },
    seeking_reassurance: {
        label: "Seeking Reassurance", icon: "fa-life-ring",
        meaning: "The character is looking for confirmation of safety, value, commitment, or continued connection.",
        effect: "Responsive support can matter strongly, while indifference or mixed signals may have outsized impact.",
    },
    trust_under_review: {
        label: "Trust Under Review", icon: "fa-magnifying-glass",
        meaning: "The character is actively reevaluating whether the user is trustworthy.",
        effect: "Consistency, honesty, and follow-through should dominate trust evaluation; ambiguous affection should not substitute for evidence.",
    },
    post_rupture_repair: {
        label: "Post-Rupture Repair", icon: "fa-bandage",
        meaning: "The relationship is in an active repair phase after a meaningful rupture.",
        effect: "Affection may remain high while trust/openness recover slowly; repair requires repeated congruent behavior rather than a single apology or gesture.",
    },
};

export function getRelationshipConditionDefinition(type) {
    return RELATIONSHIP_CONDITION_CATALOG[String(type || "").trim()] || null;
}

export function getRelationshipConditionCatalogForPrompt() {
    return Object.entries(RELATIONSHIP_CONDITION_CATALOG)
        .map(([type, def]) => `${type}=${def.label}`)
        .join(", ");
}
