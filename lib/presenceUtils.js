/** Merge scene-presence snapshots without losing earlier participants. */
export function mergeSceneCharacterIds(...lists) {
    return [...new Set(lists.flatMap((list) => Array.isArray(list) ? list : [])
        .filter((id) => typeof id === "string" && id))];
}
