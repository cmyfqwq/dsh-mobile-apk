/**
 * Field-level settings write-back for discovered capabilities (0.13.5 W3).
 *
 * Invariants (decision D6):
 *   - only *missing* fields are filled; a value the user already declared is
 *     never overwritten (not even with a "better" one);
 *   - only model-level entries are written — never a provider-wide setting;
 *   - the route's other keys and every other model's entry are left byte-identical;
 *   - one `set` on `providers.<route>.models` under the current revision, with a
 *     single re-read/retry on SETTINGS_CONFLICT (same protocol as model-sync).
 */
import type { ReasoningEfforts } from './capability-probe.js'

export interface ModelPatch {
  id: string
  reasoningEfforts?: ReasoningEfforts
  input?: string[]
  contextWindow?: number
  maxTokens?: number
  compat?: Record<string, unknown>
  /** Provenance label recorded in the change log, e.g. 'engine-catalog'. */
  source?: string
}

export interface PlanResult {
  /** The complete models array to write (unchanged entries preserved verbatim). */
  models: unknown[]
  /** Human-readable list of fields actually added. */
  changes: string[]
  /** Model ids that were declared but could not be patched, with the reason. */
  skipped: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function idOf(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry
  if (isRecord(entry) && typeof entry.id === 'string') return entry.id
  return undefined
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (Array.isArray(value)) return value.length === 0
  if (isRecord(value)) return Object.keys(value).length === 0
  return false
}

/**
 * Builds the write-back plan. [patches] are applied in order; the first patch for
 * a given id wins for a field that is still missing after earlier patches.
 */
export function planModelPatch(rawModels: unknown, patches: ModelPatch[]): PlanResult {
  const models = Array.isArray(rawModels) ? [...rawModels] : []
  const changes: string[] = []
  const skipped: string[] = []
  if (models.length === 0) {
    for (const patch of patches) skipped.push(`${patch.id}: 路由未声明该模型（不凭空创建条目）`)
    return { models, changes, skipped }
  }

  for (const patch of patches) {
    const index = models.findIndex((entry) => idOf(entry) === patch.id)
    if (index < 0) {
      skipped.push(`${patch.id}: 路由未声明该模型（不凭空创建条目）`)
      continue
    }
    let entry = models[index]
    if (typeof entry === 'string') entry = { id: entry }
    if (!isRecord(entry)) {
      skipped.push(`${patch.id}: 条目形态无法写入`)
      continue
    }
    const next: Record<string, unknown> = { ...entry }
    const tag = patch.source ? ` (${patch.source})` : ''

    if (patch.reasoningEfforts && isEmpty(next.reasoningEfforts)) {
      next.reasoningEfforts = patch.reasoningEfforts
      changes.push(`${patch.id}: 补 reasoningEfforts=${Object.keys(patch.reasoningEfforts).join('/')}${tag}`)
    }
    if (patch.input && patch.input.length > 0 && isEmpty(next.input)) {
      next.input = patch.input
      changes.push(`${patch.id}: 补 input=${patch.input.join('/')}${tag}`)
    }
    if (typeof patch.contextWindow === 'number' && isEmpty(next.contextWindow)) {
      next.contextWindow = patch.contextWindow
      changes.push(`${patch.id}: 补 contextWindow=${patch.contextWindow}${tag}`)
    }
    if (typeof patch.maxTokens === 'number' && isEmpty(next.maxTokens)) {
      next.maxTokens = patch.maxTokens
      changes.push(`${patch.id}: 补 maxTokens=${patch.maxTokens}${tag}`)
    }
    if (patch.compat) {
      const existingCompat = isRecord(next.compat) ? { ...next.compat } : {}
      const added: string[] = []
      for (const [key, value] of Object.entries(patch.compat)) {
        if (existingCompat[key] === undefined) {
          existingCompat[key] = value
          added.push(key)
        }
      }
      if (added.length > 0) {
        next.compat = existingCompat
        changes.push(`${patch.id}: 补 compat.${added.join(',')}${tag}`)
      }
    }

    if (changes.length > 0 || next !== entry) models[index] = next
  }

  return { models, changes, skipped }
}

export interface SettingsDescriptorLike {
  ns: string
  value: unknown
  revision: number
}

export interface SettingsWriteLike {
  describe(options?: { namespaces?: readonly string[] }): SettingsDescriptorLike[]
  mutate(ns: string, ops: unknown[], expectedRevision?: number): Promise<unknown>
}

export interface WriteResult {
  wrote: boolean
  reason: string
  changes: string[]
  skipped: string[]
}

function modelsOf(descriptor: SettingsDescriptorLike, route: string): unknown {
  const section = isRecord(descriptor.value) ? descriptor.value : {}
  const providers = isRecord(section.providers) ? section.providers : {}
  const routeConfig = isRecord(providers[route]) ? providers[route] as Record<string, unknown> : {}
  return routeConfig.models
}

/**
 * Applies [patches] to one route's model list. Returns what happened; never throws
 * for an ordinary rejection (the caller reports it).
 */
export async function applyModelPatch(
  settings: SettingsWriteLike | undefined,
  route: string,
  patches: ModelPatch[],
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void },
): Promise<WriteResult> {
  if (!settings) return { wrote: false, reason: 'settings-unavailable', changes: [], skipped: [] }
  if (patches.length === 0) return { wrote: false, reason: 'nothing-to-apply', changes: [], skipped: [] }

  const run = async (retry: boolean): Promise<WriteResult> => {
    const descriptor = settings.describe({ namespaces: ['llm-pi-ai'] }).find((d) => d.ns === 'llm-pi-ai')
    if (!descriptor) return { wrote: false, reason: 'namespace-absent', changes: [], skipped: [] }
    const plan = planModelPatch(modelsOf(descriptor, route), patches)
    if (plan.changes.length === 0) {
      return { wrote: false, reason: 'no-change', changes: [], skipped: plan.skipped }
    }
    try {
      await settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', route, 'models'], value: plan.models }], descriptor.revision)
      return { wrote: true, reason: 'wrote', changes: plan.changes, skipped: plan.skipped }
    } catch (error) {
      const code = (error as { code?: string })?.code
      if (code === 'SETTINGS_CONFLICT' && !retry) {
        logger?.info?.(`dsh-model-capability: SETTINGS_CONFLICT for route ${route}; retrying once`)
        return run(true)
      }
      logger?.warn?.(`dsh-model-capability: write-back failed for route ${route}: ${(error as Error)?.message ?? String(error)}`)
      return { wrote: false, reason: code === 'SETTINGS_CONFLICT' ? 'conflict-retry-failed' : 'mutate-rejected', changes: [], skipped: plan.skipped }
    }
  }

  return run(false)
}
