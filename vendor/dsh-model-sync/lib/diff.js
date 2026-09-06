// Plan C (settings-seam): diff utilities for model sync reporting.
/**
 * Compare a provider's model ids before and after a refresh. Order of the
 * `after` list is preserved for `added`; `removed` keeps the `before` order.
 */
export function diffModelIds(before, after) {
    const afterSet = new Set(after);
    const removed = before.filter((id) => !afterSet.has(id));
    const beforeSet = new Set(before);
    const added = after.filter((id) => !beforeSet.has(id));
    return { added, removed };
}
/**
 * Content-level diff between current and target settings model profiles.
 *
 * Both arrays must be sorted by id (as translateEntries and settings raw
 * segments are). Reports added/removed ids and per-field changes for
 * entries present in both.
 */
export function diffEntries(current, target) {
    const currentById = new Map(current.map((e) => [e.id, e]));
    const targetById = new Map(target.map((e) => [e.id, e]));
    const added = [];
    const removed = [];
    const changed = [];
    // Find added (in target, not current)
    for (const id of targetById.keys()) {
        if (!currentById.has(id))
            added.push(id);
    }
    // Find removed (in current, not target)
    for (const id of currentById.keys()) {
        if (!targetById.has(id))
            removed.push(id);
    }
    // Find changed (in both, compare fields)
    for (const [id, targetEntry] of targetById) {
        const currentEntry = currentById.get(id);
        if (currentEntry === undefined)
            continue;
        const allKeys = new Set([...Object.keys(currentEntry), ...Object.keys(targetEntry)]);
        for (const key of allKeys) {
            if (key === 'id')
                continue;
            const currentVal = currentEntry[key];
            const targetVal = targetEntry[key];
            if (!shallowEqual(currentVal, targetVal)) {
                changed.push({ id, field: key, current: currentVal, target: targetVal });
            }
        }
    }
    return {
        added,
        removed,
        changed,
        hasChanges: added.length > 0 || removed.length > 0 || changed.length > 0,
    };
}
/**
 * Shallow/structural equality for diff comparison.
 * Handles primitives, arrays (element-wise), and plain objects (key-wise).
 */
function shallowEqual(a, b) {
    if (a === b)
        return true;
    if (a === undefined && b === undefined)
        return true;
    if (a === null && b === null)
        return true;
    if (a === null || b === null)
        return false;
    if (typeof a !== typeof b)
        return false;
    if (typeof a !== 'object')
        return false;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length)
            return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i])
                return false;
        }
        return true;
    }
    if (Array.isArray(a) !== Array.isArray(b))
        return false;
    const objA = a;
    const objB = b;
    const keysA = Object.keys(objA).sort();
    const keysB = Object.keys(objB).sort();
    if (keysA.length !== keysB.length)
        return false;
    for (let i = 0; i < keysA.length; i++) {
        if (keysA[i] !== keysB[i])
            return false;
        if (objA[keysA[i]] !== objB[keysB[i]])
            return false;
    }
    return true;
}
//# sourceMappingURL=diff.js.map