// Plan C (settings-seam): translate pi.dev entries into settings-writable profiles.
// ---------------------------------------------------------------------------
// THINKING_LEVELS whitelist (§3.5)
// ---------------------------------------------------------------------------
/** A positive integer, the only usable shape for a capacity value. */
function isPositiveInt(value) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
/** Allowed thinking level keys and their valid wire-spelling constraints. */
const THINKING_LEVELS = new Set([
    'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
]);
// ---------------------------------------------------------------------------
// Core translation
// ---------------------------------------------------------------------------
/**
 * Translate a route's pi.dev entries into settings-writable profiles.
 *
 * @param entries   Raw entries from pi.dev for this route
 * @param builtinIds  Set of model ids present in the installed builtin catalog for this route
 * @param builtinData  Array of builtin catalog data (id, api, maxTokens) for this route
 * @param route     The route id (e.g. 'opencode-go')
 * @param options   Translation options
 * @param builtinOnlyEntries  Entries from builtin catalog that are not in pi.dev (for keepBuiltinOnly)
 */
export function translateEntries(entries, builtinIds, builtinData, route, options, builtinOnlyEntries) {
    const dropped = [];
    const warnings = [];
    const result = [];
    // Compute the set of distinct apis in the builtin snapshot for this route.
    // Used to detect mixed-protocol routes (§3.3 rule 13): base-less entries on
    // a route where builtin models use >1 api cannot be addressed.
    const builtinApis = new Set(builtinData.map((b) => b.api));
    for (const entry of entries) {
        const isBaseMatching = builtinIds.has(entry.id);
        const builtin = builtinData.find((b) => b.id === entry.id);
        // Determine resolved api for compat gate (rules 8/9):
        // Use builtin api if base-matching, otherwise the entry's own api
        const resolvedApi = isBaseMatching && builtin ? builtin.api : entry.api;
        // Rule 13: drop base-less entries when they truly have no api
        if (!isBaseMatching && (!entry.api || entry.api === '')) {
            dropped.push({
                id: entry.id,
                route,
                reason: `base-less entry "${entry.id}" has no api — cannot resolve`,
                severity: 'drop',
            });
            continue;
        }
        // Rule 13 (extended): drop base-less entries on mixed-protocol routes.
        // When builtin models use >1 api, a base-less entry has no addressable api
        // because the route is ambiguous — the runtime can't pick the right adapter.
        if (!isBaseMatching && builtinApis.size > 1) {
            dropped.push({
                id: entry.id,
                route,
                reason: `base-less entry "${entry.id}" on a mixed-protocol route has no addressable api`,
                severity: 'drop',
            });
            continue;
        }
        // Rule 1: id (always written)
        const profile = { id: entry.id };
        // Rule 2: name
        if (entry.name !== undefined)
            profile.name = entry.name;
        // Rule 3: contextWindow — only a positive integer is a usable capacity.
        // A written value overrides the installed catalog at resolution time, so
        // garbage from the listing is skipped (installed value / route default
        // then applies) instead of propagated.
        if (entry.contextWindow !== undefined) {
            if (isPositiveInt(entry.contextWindow)) {
                profile.contextWindow = entry.contextWindow;
            }
            else {
                warnings.push({
                    id: entry.id,
                    route,
                    reason: `contextWindow ${entry.contextWindow} from the listing is not a positive integer — skipped; installed value or route default applies`,
                    severity: 'degrade',
                });
            }
        }
        // Rule 4: input (modalities)
        if (entry.input !== undefined && entry.input.length > 0) {
            profile.input = [...entry.input];
        }
        // Rule 5: maxTokens — base-matching: strip; base-less: keep only when
        // sane. base-matching strips because pi-ai falls back to the catalog
        // value. base-less keeps the value, but only if it is a plausible output
        // cap: a positive integer strictly below the context window. Listings
        // sometimes echo the context window into maxTokens (e.g. grok-4.6
        // 500000/500000); written through, it becomes the request-level
        // defaultMaxTokens and trips the "output token limit" family — strip it
        // with a degrade warning instead.
        if (!isBaseMatching && entry.maxTokens !== undefined) {
            if (!isPositiveInt(entry.maxTokens)) {
                warnings.push({
                    id: entry.id,
                    route,
                    reason: `maxTokens ${entry.maxTokens} from the listing is not a positive integer — skipped; route default applies`,
                    severity: 'degrade',
                });
            }
            else if (profile.contextWindow !== undefined && entry.maxTokens >= profile.contextWindow) {
                warnings.push({
                    id: entry.id,
                    route,
                    reason: `maxTokens ${entry.maxTokens} >= contextWindow ${profile.contextWindow} — looks like a listing echo, skipped; route default applies`,
                    severity: 'degrade',
                });
            }
            else {
                profile.maxTokens = entry.maxTokens;
            }
        }
        // base-matching: don't write maxTokens (pi-ai falls back to catalog value)
        // Rule 6: reasoning (boolean) — never write
        // Rule 7: reasoningEfforts — derive with S2 gate
        const thinkingFormat = entry.compat?.thinkingFormat;
        const supportsRE = entry.compat?.supportsReasoningEffort;
        // S2 gate: thinkingFormat non-empty AND (forceMaxReasoningEffort OR supportsReasoningEffort !== false)
        if (thinkingFormat !== undefined && thinkingFormat !== '' && (options.forceMaxReasoningEffort || supportsRE !== false)) {
            // Derive reasoningEfforts as dict (§3.5)
            profile.reasoningEfforts = deriveReasoningEfforts(entry, options.forceMaxReasoningEffort);
        }
        // Rules 8/9: compat.thinkingFormat / compat.supportsReasoningEffort
        // S5 gate: only write when resolved api === 'openai-completions'
        if (resolvedApi === 'openai-completions') {
            const compat = {};
            if (entry.compat?.thinkingFormat !== undefined) {
                compat.thinkingFormat = entry.compat.thinkingFormat;
            }
            if (entry.compat?.supportsReasoningEffort !== undefined) {
                compat.supportsReasoningEffort = entry.compat.supportsReasoningEffort;
            }
            // force mode: override supportsReasoningEffort to true (only when thinkingFormat is present)
            if (options.forceMaxReasoningEffort && entry.compat?.thinkingFormat) {
                compat.supportsReasoningEffort = true;
            }
            if (Object.keys(compat).length > 0) {
                profile.compat = compat;
            }
        }
        // else: drop the compat keys (don't drop the entry itself)
        // Rules 10-12: other compat keys, api/baseUrl/provider per entry, cost/etc — never write
        // Rule 14: api-divergent entries must be written (accept protocol override)
        if (isBaseMatching && builtin && entry.api !== builtin.api) {
            warnings.push({
                id: entry.id,
                route,
                reason: `api divergence: pi.dev=${entry.api} vs installed=${builtin.api} — written, protocol will use installed`,
                severity: 'degrade',
            });
        }
        result.push(profile);
    }
    // keepBuiltinOnly: merge in builtin-only entries (§5.2)
    // Emit minimal {id} only — the adapter's ...base spread restores all fields.
    if (options.keepBuiltinOnly && builtinOnlyEntries !== undefined) {
        for (const entry of builtinOnlyEntries) {
            // Already present in pi.dev list? Skip (shouldn't happen, but guard)
            if (result.some((r) => r.id === entry.id))
                continue;
            // Minimal profile: only id. All other fields come from ...base at runtime.
            result.push({ id: entry.id });
        }
    }
    // Sort by id for stable output (§4.4)
    result.sort((a, b) => a.id.localeCompare(b.id));
    // If dropUnserviceable is false and there are drops, return empty (don't write)
    if (!options.dropUnserviceable && dropped.length > 0) {
        return { entries: [], dropped, warnings, aborted: true };
    }
    return { entries: result, dropped, warnings, aborted: false };
}
// ---------------------------------------------------------------------------
// Derive reasoningEfforts (§3.5)
// ---------------------------------------------------------------------------
/**
 * Derive reasoningEfforts dict from a pi.dev entry.
 *
 * Schema requires dict: z.dict(z.union([z.string(), z.null()]), z.union(THINKING_LEVELS)).
 * Key = effort level, value = wire spelling (string|null).
 *
 * We derive from thinkingLevelMap when available, otherwise produce a minimal
 * two-level dict with low/high using the effort name as wire spelling.
 *
 * Design doc §3.5: "dict { low: '<wire>', high: '<wire>' } — value is wire
 * spelling, not level name; may include off: null"
 *
 * @param entry  The pi.dev entry
 * @param force  When true, ensure low/high/max are all present in the result
 */
function deriveReasoningEfforts(entry, force) {
    const tlm = entry.thinkingLevelMap;
    if (tlm !== undefined && Object.keys(tlm).length > 0) {
        // Filter: only keep keys in THINKING_LEVELS whitelist with non-empty string values
        const filtered = {};
        for (const [k, v] of Object.entries(tlm)) {
            if (!THINKING_LEVELS.has(k))
                continue;
            if (typeof v === 'string' && v.length > 0) {
                filtered[k] = v;
            }
        }
        // If filtering left only 'off' (or empty), supplement with low/high defaults
        const nonOffKeys = Object.keys(filtered).filter((k) => k !== 'off');
        if (nonOffKeys.length === 0) {
            const base = { low: 'low', high: 'high' };
            if (force)
                base.max = 'max';
            return base;
        }
        // force mode: ensure low/high/max are present
        if (force) {
            if (!filtered.low)
                filtered.low = 'low';
            if (!filtered.high)
                filtered.high = 'high';
            if (!filtered.max)
                filtered.max = 'max';
        }
        return filtered;
    }
    // Fallback: minimal two-level dict (low/high)
    const base = { low: 'low', high: 'high' };
    if (force)
        base.max = 'max';
    return base;
}
//# sourceMappingURL=translate.js.map