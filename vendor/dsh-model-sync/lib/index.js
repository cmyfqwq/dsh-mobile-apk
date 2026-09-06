// Plan C (settings-seam): orchestrator with overlay and settings modes.
/**
 * dsh-model-sync — drive the llm adapter's pi.dev catalog refresh and report
 * what changed.
 *
 * Supports two write modes:
 * - 'settings' (default): self-contained fetch → translate → settings.mutate
 *   pipeline that writes directly to settings.yaml (zero patch required)
 * - 'overlay' (legacy): uses the patched dsh-llm-pi-ai's piAiCatalog.refresh()
 *   to overlay pi.dev entries in memory (requires patch)
 *
 * @module dsh-model-sync
 */
import z from '@deepseek-ai/schemastery';
import { diffModelIds, diffEntries } from "./diff.js";
import { fetchRemoteCatalog, loadModelsStore, } from "./remote-catalog.js";
import { translateEntries, } from "./translate.js";
import { syncToSettings, } from "./writer.js";
import { BUILTIN_CATALOG_SNAPSHOT } from "./builtin-catalog-snapshot.js";
import { refreshLiveCatalog, getLiveBuiltinCatalogForRoute } from "./live-catalog.js";
export const name = 'dsh-model-sync';
/** The settings seam this plugin consumes (its own config namespace). */
export const inject = ['settings'];
// dsh-settings 0.1.2-alpha.3 removed the runtime settingsNamespace() helper:
// register() now brand-checks the namespace at the type level
// (SettingsNamespaceInput) and validates the same pattern at runtime. A plain
// literal is the supported spelling.
const OWN_NS = 'model-sync';
/** The `model-sync` settings namespace: user-editable in settings.yaml. */
const ModelSyncConfig = z.object({
    /**
     * Write mode: 'settings' (default, zero-patch settings.mutate pipeline) or
     * 'overlay' (legacy, delegates to the patched adapter's piAiCatalog.refresh
     * and requires the optional patch).
     */
    writeMode: z.union(['settings', 'overlay']).default('settings'),
    /** Minutes between auto refreshes (default 240 = 4 hours); 0 = startup-only. */
    intervalMinutes: z.number().step(1).min(0).default(240),
    /** Delay before the first auto refresh, so the llm adapter is ready. */
    startupDelaySeconds: z.number().step(1).min(0).default(5),
    /** Abort budget for one forced refresh's network round. */
    refreshTimeoutMs: z.number().step(1).min(1000).default(120000),
    /** Routes to manage (empty = all pi.dev routes). */
    managedRoutes: z.array(z.string()).default([]),
    /** Keep builtin-only models not in pi.dev (smooth migration). */
    keepBuiltinOnly: z.boolean().default(true),
    /** Drop unserviceable entries (true) or abort the entire route (false). */
    dropUnserviceable: z.boolean().default(true),
    /** Notify on changes (logger + /model-sync report). */
    syncNotify: z.boolean().default(false),
    /**
     * Force all models with a non-empty thinkingFormat to have max reasoning
     * effort. Skips S2 gate's SRE check, ensures reasoningEfforts contains
     * max, and forces compat.supportsReasoningEffort=true (S5 gate, openai-
     * completions only). 400 risk is on the user.
     */
    forceMaxReasoningEffort: z.boolean().default(false),
});
/**
 * Default routes to manage when managedRoutes is empty.
 *
 * NOTE (intentional deviation from design doc §5.5): the design suggests
 * dynamically enumerating routes from the llm adapter's provider list, but
 * that requires pi.dev to have been fetched first — unavailable during
 * bootstrap. A static list is the pragmatic fallback; update manually when
 * new routes appear on pi.dev.
 */
const DEFAULT_ROUTES = [
    'opencode-go',
    'zai-coding-cn',
    'minimax-cn',
    'xiaomi-token-plan-cn',
];
export function apply(ctx) {
    const scope = ctx.settings.register(OWN_NS, ModelSyncConfig);
    // -----------------------------------------------------------------------
    // Overlay mode sync (existing behavior)
    // -----------------------------------------------------------------------
    const syncOverlay = async (config, llm, force) => {
        const catalog = ctx.get('piAiCatalog');
        if (catalog?.refresh === undefined) {
            // Degradation path (never throws): the overlay needs a hand-patched
            // dsh-llm-pi-ai exposing piAiCatalog.refresh(). Since dsh 0.1.2-alpha.3
            // the patch cannot even apply (it shims settingsNamespace and
            // installSettingsSection, both removed from dsh-settings), so hosts on
            // the alpha line always land here unless they run the settings mode.
            return 'catalog refresh is unavailable — the dsh-llm-pi-ai remote-catalog patch is not applied; the model list is the static catalog only.';
        }
        let providers;
        try {
            providers = llm.listProviders();
        }
        catch {
            return 'llm service is not ready yet; try again shortly.';
        }
        if (providers.length === 0)
            return 'No providers configured under llm-pi-ai.';
        const list = async () => {
            const out = new Map();
            await Promise.all(providers.map(async (provider) => {
                try {
                    out.set(provider.id, (await llm.listModels(provider.id)).map((model) => model.id));
                }
                catch {
                    out.set(provider.id, []);
                }
            }));
            return out;
        };
        const before = await list();
        const errors = await catalog.refresh({
            force,
            signal: AbortSignal.timeout(config.refreshTimeoutMs),
        });
        const after = await list();
        const lines = [];
        for (const provider of providers) {
            const error = errors.get(provider.id);
            if (error !== undefined) {
                lines.push(`${provider.id}: refresh failed (${error instanceof Error ? error.message : String(error)})`);
                continue;
            }
            const beforeIds = before.get(provider.id) ?? [];
            const afterIds = after.get(provider.id) ?? [];
            const { added, removed } = diffModelIds(beforeIds, afterIds);
            if (added.length === 0 && removed.length === 0) {
                lines.push(`${provider.id}: up to date (${afterIds.length} models)`);
                continue;
            }
            const parts = [];
            if (added.length > 0)
                parts.push(`+${added.join(', +')}`);
            if (removed.length > 0)
                parts.push(`-${removed.join(', -')}`);
            lines.push(`${provider.id}: ${parts.join('; ')} (now ${afterIds.length} models)`);
        }
        return lines.join('\n');
    };
    // -----------------------------------------------------------------------
    // Settings mode sync (Plan C: fetch → translate → write)
    // -----------------------------------------------------------------------
    const syncSettings = async (config, force) => {
        const settings = ctx.get('settings');
        const logger = ctx.logger;
        const store = loadModelsStore();
        const lines = [];
        // Determine routes to sync
        const routes = config.managedRoutes.length > 0
            ? config.managedRoutes
            : DEFAULT_ROUTES;
        for (const route of routes) {
            // Fetch from pi.dev — pass force to bypass revalidation throttle (I-5)
            const result = await fetchRemoteCatalog(route, config.refreshTimeoutMs, store, { force });
            if (result.error !== undefined && result.entries.length === 0) {
                lines.push(`${route}: fetch failed (${result.error}); keeping last-good`);
                continue;
            }
            if (result.entries.length === 0) {
                lines.push(`${route}: no models from pi.dev; skipped`);
                continue;
            }
            // Translate
            const translateOpts = {
                keepBuiltinOnly: config.keepBuiltinOnly,
                dropUnserviceable: config.dropUnserviceable,
                dropWarnings: [],
                forceMaxReasoningEffort: config.forceMaxReasoningEffort,
            };
            // For builtin catalog snapshot: we use a mock for now since we can't
            // import pi-ai at runtime. The builtin catalog data is needed for
            // base-matching classification. In a real deployment, this would come
            // from the built-in snapshot file.
            const builtinData = getBuiltinCatalogForRoute(route);
            const builtinIds = new Set(builtinData.map((b) => b.id));
            const builtinOnlyEntries = config.keepBuiltinOnly
                ? getBuiltinOnlyEntries(route, result.entries, builtinIds)
                : undefined;
            const translated = translateEntries(result.entries, builtinIds, builtinData, route, translateOpts, builtinOnlyEntries);
            // Report drops and warnings
            if (translated.dropped.length > 0) {
                for (const w of translated.dropped) {
                    lines.push(`${route}: DROPPED ${w.id} — ${w.reason}`);
                }
            }
            if (translated.warnings.length > 0) {
                for (const w of translated.warnings) {
                    lines.push(`${route}: DEGRADED ${w.id} — ${w.reason}`);
                }
            }
            // B1: abort detected — skip writer, only warn
            if (translated.aborted) {
                lines.push(`${route}: ABORTED — dropUnserviceable=false and ${translated.dropped.length} entries dropped; settings not written`);
                continue;
            }
            // I-6: generate added/removed diff report from current raw models
            if (settings !== undefined) {
                const descs = settings.describe();
                const llmDesc = descs.find((d) => d.ns === 'llm-pi-ai');
                const rawModels = getRawUserModelsFromDesc(llmDesc, route);
                if (rawModels !== undefined) {
                    const entryDiff = diffEntries(rawModels, translated.entries);
                    if (entryDiff.added.length > 0)
                        lines.push(`${route}: added ${entryDiff.added.join(', ')}`);
                    if (entryDiff.removed.length > 0)
                        lines.push(`${route}: removed ${entryDiff.removed.join(', ')}`);
                }
            }
            // Write to settings (change-only, with conflict retry); the store
            // carries the modelOverrides replay/persist (mutual-exclusion fix)
            const syncResult = await syncToSettings(settings, route, translated.entries, logger, 
            // retranslate callback for conflict retry
            async (newRevision) => {
                // Re-translate with same data (the remote data hasn't changed;
                // only the settings revision changed)
                void newRevision; // revision is used by the caller
                return translated.entries;
            }, store);
            if (syncResult.wrote) {
                // Detail suffix for the override flows; routes without overrides keep
                // the classic "(wrote)" line byte-for-byte.
                const reason = syncResult.reason === 'wrote' ? '' : `${syncResult.reason}; `;
                let detail;
                if (syncResult.overridesSource === 'settings') {
                    detail = `${reason}folded user modelOverrides, unset the key`;
                }
                else if (syncResult.overridesSource === 'store') {
                    detail = `${reason}applied stored modelOverrides`;
                }
                if (detail !== undefined && syncResult.droppedOverrideIds !== undefined && syncResult.droppedOverrideIds.length > 0) {
                    detail += `; override ids not in target kept in models-store: ${syncResult.droppedOverrideIds.join(', ')}`;
                }
                lines.push(detail !== undefined
                    ? `${route}: wrote ${translated.entries.length} models (${detail})`
                    : `${route}: wrote ${translated.entries.length} models (${syncResult.reason})`);
            }
            else if (syncResult.reason === 'no-change') {
                lines.push(`${route}: up to date (${translated.entries.length} models)`);
            }
            else if (syncResult.reason === 'skipped') {
                lines.push(`${route}: skipped — settings service unavailable or llm-pi-ai namespace not registered`);
            }
            else if (syncResult.reason === 'mutate-rejected') {
                lines.push(`${route}: rejected by settings validation (see log)`);
            }
            else if (syncResult.reason === 'store-unavailable') {
                // The store failed (corrupt/permission on read, or filesystem on
                // write); settings.models was the authoritative source and stays
                // untouched either way — the user's folded values are preserved.
                lines.push(`${route}: skipped (models-store unavailable; settings untouched)`);
            }
            else {
                lines.push(`${route}: ${syncResult.reason} (${translated.entries.length} models)`);
            }
        }
        return lines.join('\n');
    };
    // -----------------------------------------------------------------------
    // Unified syncNow
    // -----------------------------------------------------------------------
    const syncNow = async (force) => {
        const config = scope.get();
        // Prefer the host's live pi-ai catalog for this round; the frozen
        // snapshot is only the no-host fallback. Without this, keepBuiltinOnly
        // re-emits ids the host's catalog has already dropped.
        refreshLiveCatalog(config.managedRoutes.length > 0 ? config.managedRoutes : DEFAULT_ROUTES);
        if (config.writeMode === 'settings') {
            return syncSettings(config, force);
        }
        // Overlay mode (existing behavior)
        const llm = ctx.get('llm');
        if (llm === undefined || llm.listProviders === undefined || llm.listModels === undefined) {
            return 'llm service is not available yet; try again shortly.';
        }
        return syncOverlay(config, llm, force);
    };
    /** Auto rounds log the same report the /model-sync command shows. */
    const runAuto = () => {
        void syncNow(false).then((report) => {
            for (const line of report.split('\n'))
                ctx.logger.info('model-sync: %s', line);
        });
    };
    /** (Re)arm the auto-refresh interval; 0 disarms. */
    const armInterval = (minutes) => {
        if (stopInterval !== undefined)
            clearInterval(stopInterval);
        stopInterval = undefined;
        if (minutes > 0)
            stopInterval = setInterval(runAuto, minutes * 60_000);
    };
    let stopInterval;
    let startupTimer;
    // One effect releases whatever timers are live at dispose.
    ctx.effect(() => () => {
        if (stopInterval !== undefined)
            clearInterval(stopInterval);
        if (startupTimer !== undefined)
            clearTimeout(startupTimer);
    });
    const initial = scope.get();
    startupTimer = setTimeout(runAuto, Math.max(0, initial?.startupDelaySeconds ?? 5) * 1000);
    armInterval(initial?.intervalMinutes ?? 240);
    scope.watch((next) => {
        const value = next;
        armInterval(value?.intervalMinutes ?? 0);
        // Clear any pending startup timer before setting a new one
        if (startupTimer !== undefined)
            clearTimeout(startupTimer);
        startupTimer = setTimeout(runAuto, 1000);
    });
    // The modelSync service stays exposed for UIs that want direct access. The
    // /model-sync command itself is registered by this plugin (below) through
    // the shared command registry, which interactive UIs discover on their own.
    ctx.provide('modelSync', { syncNow: () => syncNow(true) });
    // Register the /model-sync slash command from the plugin itself. The
    // registry is @deepseek-ai/dsh-commands' CommandRuntime ("Plugin-owned
    // human-command registry shared by interactive UI adapters") — registration
    // is global, so every interactive UI lists the command without any UI-side
    // wiring. The registry is an optional peer: the `ctx.inject` sub-fiber stays
    // dormant until the host provides the `commands` service, so hosts without
    // the registry keep every other feature working. A bare `ctx.commands` read
    // without a declared inject throws in cordis 4.
    ctx.inject(['commands'], (cmdCtx) => {
        const commands = cmdCtx.commands;
        if (commands?.register === undefined)
            return;
        cmdCtx.effect(() => {
            const definition = {
                name: 'model-sync',
                description: 'Force one model-list sync round from the pi.dev gateway into settings (dsh-model-sync)',
                handler: async (invocation) => {
                    const ignored = invocation.rawInput.trim().length > 0
                        ? 'The sync scope is decided by the model-sync managedRoutes config; the argument is ignored.\n'
                        : '';
                    try {
                        const report = await syncNow(true);
                        return { kind: 'success', text: `${ignored}${report}` };
                    }
                    catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        return { kind: 'error', text: `${ignored}model-sync failed: ${message}` };
                    }
                },
            };
            return commands.register(definition);
        }, 'dsh-model-sync: /model-sync');
    });
}
// ---------------------------------------------------------------------------
// Builtin catalog helpers (uses shared snapshot)
// ---------------------------------------------------------------------------
/**
 * Get builtin catalog data for a route: the host's live pi-ai catalog when it
 * can be located, the frozen build-time snapshot otherwise. Live-first is the
 * point — the snapshot rots when the host's bundled pi-ai drops models
 * (grok-4.5 was removed in pi-ai 0.84.4), and a stale keepBuiltinOnly entry
 * gets the whole llm-pi-ai namespace rejected by the alpha line's strict
 * registration.
 */
function getBuiltinCatalogForRoute(route) {
    return getLiveBuiltinCatalogForRoute(route) ?? BUILTIN_CATALOG_SNAPSHOT[route] ?? [];
}
/**
 * Get entries from builtin catalog that are not in pi.dev (for keepBuiltinOnly).
 * Returns minimal RemoteCatalogEntry-shaped objects — translateEntries only
 * reads entry.id from these, emitting {id} profiles (I-3).
 */
function getBuiltinOnlyEntries(route, piDevEntries, builtinIds) {
    const piDevIds = new Set(piDevEntries.map((e) => e.id));
    const builtinData = getBuiltinCatalogForRoute(route);
    return builtinData
        .filter((b) => !piDevIds.has(b.id) && builtinIds.has(b.id))
        .map((b) => ({
        id: b.id,
        name: b.id,
        api: b.api,
        provider: route,
        baseUrl: '',
        reasoning: false,
        input: ['text'],
    }));
}
/**
 * Extract raw user-segment models for a route from a settings descriptor (I-6).
 */
function getRawUserModelsFromDesc(desc, route) {
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
//# sourceMappingURL=index.js.map