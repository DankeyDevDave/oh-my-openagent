import { log } from "./logger"

/**
 * Provider health check module.
 *
 * Performs lightweight preflight probes to verify that a provider endpoint is
 * actually reachable before delegating work to a subagent. This catches the
 * case where a provider appears "connected" in the cache but the underlying
 * endpoint (e.g. a local proxy) has crashed.
 *
 * Related: #3269 — provider health/preflight check before subagent delegation.
 */

interface HealthEntry {
  healthy: boolean
  checkedAt: number
}

const LOG_PREFIX = "provider-health-check"

/** In-memory TTL cache: providerID → health status */
const healthCache = new Map<string, HealthEntry>()

/** Default TTL for cached health results (30 seconds). */
const DEFAULT_CACHE_TTL_MS = 30_000

/** Timeout for the health probe request (4 seconds). */
const DEFAULT_PROBE_TIMEOUT_MS = 4_000

export type ProviderListClient = {
  provider?: {
    list?: () => Promise<{
      data?: {
        connected?: string[]
        all?: Array<{ id: string; models?: Record<string, unknown> }>
      }
    }>
  }
}

/**
 * Checks whether a provider endpoint is reachable by issuing a fresh
 * `client.provider.list()` call and verifying the target provider appears
 * in the connected list.
 *
 * Results are cached for `cacheTtlMs` to avoid hammering on every delegation.
 */
export async function checkProviderHealth(
  client: ProviderListClient,
  providerID: string,
  options?: { cacheTtlMs?: number; probeTimeoutMs?: number },
): Promise<boolean> {
  const cacheTtl = options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  const probeTimeout = options?.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS

  // Check in-memory cache first
  const cached = healthCache.get(providerID)
  if (cached && Date.now() - cached.checkedAt < cacheTtl) {
    log(`[${LOG_PREFIX}] cache hit`, { providerID, healthy: cached.healthy })
    return cached.healthy
  }

  const healthy = await probeProvider(client, providerID, probeTimeout)

  healthCache.set(providerID, { healthy, checkedAt: Date.now() })
  log(`[${LOG_PREFIX}] probe result`, { providerID, healthy })

  return healthy
}

/**
 * Checks health of multiple providers in a single probe call.
 * Returns a Map of providerID → healthy.
 */
export async function checkProvidersHealth(
  client: ProviderListClient,
  providerIDs: string[],
  options?: { cacheTtlMs?: number; probeTimeoutMs?: number },
): Promise<Map<string, boolean>> {
  const cacheTtl = options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  const probeTimeout = options?.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const results = new Map<string, boolean>()

  // Separate cached from uncached
  const uncachedProviders: string[] = []
  for (const id of providerIDs) {
    const cached = healthCache.get(id)
    if (cached && Date.now() - cached.checkedAt < cacheTtl) {
      results.set(id, cached.healthy)
    } else {
      uncachedProviders.push(id)
    }
  }

  if (uncachedProviders.length === 0) {
    return results
  }

  // Single probe call to check all uncached providers
  const liveConnected = await probeLiveProviders(client, probeTimeout)
  const now = Date.now()

  for (const id of uncachedProviders) {
    const healthy = liveConnected !== null ? liveConnected.has(id.toLowerCase()) : true
    healthCache.set(id, { healthy, checkedAt: now })
    results.set(id, healthy)
  }

  return results
}

/**
 * Probes whether a specific provider is reachable by fetching the live
 * provider list from the OpenCode server.
 */
async function probeProvider(
  client: ProviderListClient,
  providerID: string,
  timeoutMs: number,
): Promise<boolean> {
  const liveConnected = await probeLiveProviders(client, timeoutMs)
  if (liveConnected === null) {
    // If we can't reach the server at all, assume healthy to avoid blocking
    return true
  }
  return liveConnected.has(providerID.toLowerCase())
}

/**
 * Fetches the live connected providers set from the OpenCode server,
 * with a timeout to avoid blocking delegation.
 *
 * Returns null if the probe failed (e.g. server unreachable).
 */
async function probeLiveProviders(
  client: ProviderListClient,
  timeoutMs: number,
): Promise<Set<string> | null> {
  if (!client?.provider?.list) {
    log(`[${LOG_PREFIX}] client.provider.list not available`)
    return null
  }

  try {
    const result = await Promise.race([
      client.provider.list(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Health probe timed out")), timeoutMs),
      ),
    ])

    const connected = result.data?.connected ?? []
    return new Set(connected.map((id) => id.toLowerCase()))
  } catch (err) {
    log(`[${LOG_PREFIX}] probe failed`, { error: String(err) })
    return null
  }
}

/**
 * Finds the first healthy provider from a list of candidates.
 * Used by the delegate-task flow to skip unreachable providers proactively.
 */
export async function findFirstHealthyProvider(
  client: ProviderListClient,
  providerIDs: string[],
  options?: { cacheTtlMs?: number; probeTimeoutMs?: number },
): Promise<string | null> {
  if (providerIDs.length === 0) return null

  const healthMap = await checkProvidersHealth(client, providerIDs, options)

  for (const id of providerIDs) {
    if (healthMap.get(id) !== false) {
      return id
    }
  }

  return null
}

/**
 * Invalidates the cached health status for a provider.
 * Call this when a provider error is detected at runtime to force a re-probe.
 */
export function invalidateProviderHealth(providerID: string): void {
  healthCache.delete(providerID)
  log(`[${LOG_PREFIX}] invalidated`, { providerID })
}

/**
 * Invalidates all cached health entries.
 */
export function invalidateAllProviderHealth(): void {
  healthCache.clear()
  log(`[${LOG_PREFIX}] invalidated all`)
}

/**
 * Resets all module state for testing.
 */
export function _resetForTesting(): void {
  healthCache.clear()
}
