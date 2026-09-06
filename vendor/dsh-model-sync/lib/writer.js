// Plan C (settings-seam): write translated model profiles to settings via mutate API.
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
/** Error code for revision mismatch in settings.mutate. */
const SETTINGS_CONFLICT = 'SETTINGS_CONFLICT';
// ---------------------------------------------------------------------------
// Content-level comparison (§4.4)
// ---------------------------------------------------------------------------
/**
 * Deep equality check for two settings model profile arrays.
 * Both arrays must be sorted by id for deterministic comparison.
 */
export function profilesEqual(current, target) {
    if (current.length !== target.length)
        return false;
    for (let i = 0; i < current.length; i++) {
        if (!deepEqual(current[i], target[i]))
            return false;
    }
    return true;
}
function deepEqual(a, b) {
    if (a === b)
        return true;
    if (a === null || b === null)
        return false;
    if (typeof a !== typeof b)
        return false;
    if (typeof a !== 'object')
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
        if (!deepEqual(objA[keysA[i]], objB[keysB[i]]))
            return false;
    }
    return true;
}
// ---------------------------------------------------------------------------
// Extract raw user segment (§4.4)
// ---------------------------------------------------------------------------
/**
 * Extract the raw user-segment models for a route from a settings descriptor.
 * Returns the raw models array (unresolved, no schema defaults applied).
 */
function getRawUserModels(desc, route) {
    if (desc === undefined)
        return undefined;
    const providers = desc.user?.providers;
    if (providers === undefined)
        return undefined;
    const routeData = providers[route];
    if (routeData === undefined)
        return undefined;
    const models = routeData.models;
    if (!Array.isArray(models))
        return undefined;
    return models;
}
/**
 * Extract raw user-segment modelOverrides for a route from a settings descriptor.
 * Returns a map of model id → override fields, or undefined if absent.
 */
function getRawUserModelOverrides(desc, route) {
    if (desc === undefined)
        return undefined;
    const providers = desc.user?.providers;
    if (providers === undefined)
        return undefined;
    const routeData = providers[route];
    if (routeData === undefined)
        return undefined;
    const overrides = routeData.modelOverrides;
    if (overrides === undefined || overrides === null || typeof overrides !== 'object')
        return undefined;
    return overrides;
}
// ---------------------------------------------------------------------------
// Override merge
// ---------------------------------------------------------------------------
/**
 * Fold the user's modelOverrides into the synced target; the override wins
 * per field. Overrides whose id is not in the target are user data for other
 * models — they stay in the overrides key untouched, never folded, never
 * dropped.
 */
function mergeOverrides(target, overrides) {
    if (overrides === undefined)
        return target;
    return target.map((entry) => {
        const override = overrides[entry.id];
        if (override === undefined)
            return entry;
        // Force the entry's own id back on: an override object that happens to
        // carry an `id` field must not silently re-key the entry in the written
        // models list.
        return { ...entry, ...override, id: entry.id };
    });
}
/**
 * Override ids that cannot fold into the target (no entry carries the id).
 * Sorted so the report line is deterministic.
 */
function droppedOverrideIds(overrides, mergedTarget) {
    if (overrides === undefined)
        return undefined;
    const targetIds = new Set(mergedTarget.map((entry) => entry.id));
    return Object.keys(overrides).filter((id) => !targetIds.has(id)).sort();
}
/**
 * Resolve the overrides to fold for one route: a non-empty settings key wins
 * (a re-added key is the user's latest intent); otherwise the models-store
 * replay applies. An empty `{}` key counts as absent — the dsh validation
 * only refuses non-empty overrides beside a models list, and there is nothing
 * in it to preserve.
 */
async function resolveOverrides(desc, route, store) {
    const raw = getRawUserModelOverrides(desc, route);
    if (raw !== undefined && Object.keys(raw).length > 0) {
        return { overrides: raw, source: 'settings' };
    }
    if (store !== undefined) {
        // The store read may now throw on corruption / permission failures
        // (remote-catalog readDoc propagates anything other than ENOENT). We
        // bubble it up: with no settings overrides to fall back on, the caller
        // must skip the round rather than fold an unreplayed target into
        // settings and clobber the folded values. With a settings key in play
        // (the earlier branch above) this code path is never reached, so a
        // settings-side write always proceeds and the atomic writeDoc heals the
        // corruption on its next write.
        const stored = await store.read(route);
        if (stored?.overrides !== undefined && Object.keys(stored.overrides).length > 0) {
            return { overrides: stored.overrides, source: 'store' };
        }
    }
    return { overrides: undefined, source: undefined };
}
/**
 * Stage overrides in the models-store BEFORE the mutate that unsets them
 * from settings (store-first). The RMW runs inside the accessor's
 * serialized write queue via `updateOverrides` — the previous read-then-
 * write pattern read OUTSIDE the queue, which let the fetch side's
 * `store.write` clobber any staged overrides that landed in the window
 * between this read and the eventual write. The queue-internal field-
 * level seed (B1) merges the stage with whatever the route currently
 * holds: `overrides` is replaced by the new value, every other field
 * (`models` / `checkedAt` / `lastModified` / `etag`) is preserved
 * verbatim when present, otherwise seeded with a sensible default.
 * A concurrent fetch write (the C1 race surface) can no longer wipe
 * the stage: the fetch-side patch only names fetch-owned fields, so
 * the seed leaves `overrides` alone. While the settings key is present
 * it always wins over the store (resolveOverrides order); the stored
 * copy is only ever replayed once the key is gone. Callers must treat
 * a throw from here as "skip the mutate": unsetting without a staged
 * copy is the v0.1.5 data loss.
 *
 * The store read may fail on corruption / permission errors (the
 * queue's internal read tolerates them by treating the doc as empty,
 * then the atomic writeDoc replaces the bad file with a fresh,
 * well-formed entry — the self-heal). The field-level seed keeps the
 * resulting entry well-formed (models: [], checkedAt: Date.now(),
 * lastModified: 0, etag: undefined, overrides: <stage>), so the fetch
 * side can consume it on its next round. (A storeless call — store
 * undefined — cannot stage anything and keeps the legacy
 * unset-without-copy behavior; production wiring in index.ts always
 * passes a store.)
 */
async function persistOverridesToStore(store, route, overrides) {
    if (store === undefined)
        return;
    await store.updateOverrides(route, overrides);
}
// ---------------------------------------------------------------------------
// syncToSettings (§4)
// ---------------------------------------------------------------------------
/**
 * Write translated model profiles to settings for a given route.
 *
 * Implements the full §4 protocol (revised for the modelOverrides mutual
 * exclusion):
 * 1. Get revision from describe()
 * 2. Resolve the overrides to fold: the settings key when non-empty, the
 *    models-store replay otherwise; merge into the target (override wins per
 *    field)
 * 3. Change-only write: skip when the raw user-segment models already equal
 *    the merged target — except when the settings key is present, because the
 *    models+overrides combo is refused by the llm-pi-ai validation (the
 *    set+unset must run to move the document out of the refused shape)
 * 4. Store-first: when the settings key is present, stage the raw overrides
 *    in the models-store BEFORE the mutate; a store write failure skips the
 *    mutate entirely and reports 'store-unavailable' (settings untouched —
 *    the key is never unset without a stored copy). Then call mutate with
 *    expectedRevision: one `set` on the models path, plus an `unset` on the
 *    modelOverrides path (atomic in a single mutate).
 * 5. On SETTINGS_CONFLICT: re-read, re-translate (caller's job), re-resolve
 *    the overrides from the fresh descriptor, stage again (store-first),
 *    re-write once
 *
 * @param settings  The settings service (injected, not imported)
 * @param route     The provider route id
 * @param target    Translated settings-writable entries (sorted by id)
 * @param logger    Logger for warnings/errors
 * @param retranslate  Callback to re-translate on conflict (receives new revision)
 * @param store  The models-store accessor for the overrides replay/persist
 */
export async function syncToSettings(settings, route, target, logger, retranslate, store) {
    if (settings === undefined) {
        logger.debug('settings service unavailable; skip write for route %s', route);
        return { wrote: false, reason: 'skipped' };
    }
    const descriptors = settings.describe();
    const desc = descriptors.find((d) => d.ns === 'llm-pi-ai');
    if (desc === undefined) {
        logger.debug('llm-pi-ai namespace not registered; skip write for route %s', route);
        return { wrote: false, reason: 'skipped' };
    }
    const rawModels = getRawUserModels(desc, route);
    let effectiveOverrides;
    let overridesSource;
    try {
        ({ overrides: effectiveOverrides, source: overridesSource } =
            await resolveOverrides(desc, route, store));
    }
    catch (readErr) {
        // The store is unreadable (corrupted JSON, EACCES, …) and settings
        // carries no overrides key — there is no authoritative source for the
        // user's folded values other than the existing settings.models. Skip
        // the round with reason 'store-unavailable': writing the raw pi.dev
        // target now would overwrite settings.models with unreplayed values
        // and silently clobber the user's fold (the same data-loss shape
        // v0.1.5 hit, just via a different path). The next refresh attempts
        // the same round again; a manual re-add of the key (or a fresh
        // successful settings-side write that heals the file) unblocks it.
        logger.warn('models-store read failed for route %s: %s', route, readErr instanceof Error ? readErr.message : String(readErr));
        return { wrote: false, reason: 'store-unavailable' };
    }
    const hasSettingsOverrides = overridesSource === 'settings';
    const mergedTarget = mergeOverrides(target, effectiveOverrides);
    // Change-only write (§4.4): skip when the stored models already reflect
    // target ⊕ overrides. Skipped when the settings key is present — the unset
    // must run in this mutate to clear the refused models+overrides combo, and
    // after it lands the replay keeps later rounds change-only.
    if (!hasSettingsOverrides && rawModels !== undefined && profilesEqual(rawModels, mergedTarget)) {
        logger.debug('no change for route %s; skip write', route);
        return { wrote: false, reason: 'no-change' };
    }
    const dropped = droppedOverrideIds(effectiveOverrides, mergedTarget);
    const ops = [
        { op: 'set', path: ['providers', route, 'models'], value: mergedTarget },
    ];
    if (hasSettingsOverrides) {
        ops.push({ op: 'unset', path: ['providers', route, 'modelOverrides'] });
    }
    // Store-first: stage the raw overrides in the models-store BEFORE the
    // mutate that unsets them from settings. A store write failure must skip
    // the mutate entirely — unsetting without a staged copy is the v0.1.5
    // data loss — and settings stays untouched, so it remains the
    // authoritative source. Reported honestly as 'store-unavailable': the
    // mutate never ran, so 'mutate-rejected' would be a lie.
    if (hasSettingsOverrides && effectiveOverrides !== undefined) {
        try {
            await persistOverridesToStore(store, route, effectiveOverrides);
        }
        catch (persistErr) {
            logger.warn('models-store persist failed for route %s: %s', route, persistErr instanceof Error ? persistErr.message : String(persistErr));
            return { wrote: false, reason: 'store-unavailable' };
        }
    }
    try {
        await settings.mutate('llm-pi-ai', ops, desc.revision);
        return { wrote: true, reason: 'wrote', overridesSource, droppedOverrideIds: dropped };
    }
    catch (err) {
        // Check for SETTINGS_CONFLICT
        const code = err?.code;
        if (code !== SETTINGS_CONFLICT) {
            logger.warn('mutate failed for route %s: %s', route, err instanceof Error ? err.message : String(err));
            return { wrote: false, reason: 'mutate-rejected' };
        }
        // Retry once: re-read revision, re-translate, re-write
        logger.info('SETTINGS_CONFLICT for route %s; retrying once', route);
        if (retranslate === undefined) {
            logger.warn('no retranslate callback; giving up for route %s', route);
            return { wrote: false, reason: 'conflict-retry-failed' };
        }
        try {
            const newDescriptors = settings.describe();
            const newDesc = newDescriptors.find((d) => d.ns === 'llm-pi-ai');
            if (newDesc === undefined) {
                logger.warn('llm-pi-ai namespace disappeared on retry for route %s', route);
                return { wrote: false, reason: 'conflict-retry-failed' };
            }
            const newTarget = await retranslate(newDesc.revision);
            let retry;
            try {
                retry = await resolveOverrides(newDesc, route, store);
            }
            catch (readErr) {
                // Same fail-closed contract as the main path: with the settings key
                // gone between the two attempts, the store replay is the only way
                // to recover the fold; an unreadable store leaves the user values
                // stranded in settings.models. Skip the retry, report honestly.
                logger.warn('models-store read failed for route %s on retry: %s', route, readErr instanceof Error ? readErr.message : String(readErr));
                return { wrote: false, reason: 'store-unavailable' };
            }
            const retryHasSettingsOverrides = retry.source === 'settings';
            const retryMerged = mergeOverrides(newTarget, retry.overrides);
            const retryDropped = droppedOverrideIds(retry.overrides, retryMerged);
            const retryOps = [
                { op: 'set', path: ['providers', route, 'models'], value: retryMerged },
            ];
            if (retryHasSettingsOverrides) {
                retryOps.push({ op: 'unset', path: ['providers', route, 'modelOverrides'] });
            }
            // Store-first again on the retry: the overrides were re-resolved from
            // the fresh descriptor, so stage them before the retry mutate (the
            // user may have changed or removed the key between the attempts).
            if (retryHasSettingsOverrides && retry.overrides !== undefined) {
                try {
                    await persistOverridesToStore(store, route, retry.overrides);
                }
                catch (persistErr) {
                    logger.warn('models-store persist failed for route %s: %s', route, persistErr instanceof Error ? persistErr.message : String(persistErr));
                    return { wrote: false, reason: 'store-unavailable' };
                }
            }
            await settings.mutate('llm-pi-ai', retryOps, newDesc.revision);
            return {
                wrote: true,
                reason: 'conflict-retry-ok',
                overridesSource: retry.source,
                droppedOverrideIds: retryDropped,
            };
        }
        catch (retryErr) {
            logger.warn('conflict retry failed for route %s: %s', route, retryErr instanceof Error ? retryErr.message : String(retryErr));
            return { wrote: false, reason: 'conflict-retry-failed' };
        }
    }
}
//# sourceMappingURL=writer.js.map