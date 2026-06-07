/// <reference types="bun-types" />

import { describe, expect, test, beforeEach, mock } from "bun:test"

const logMock = mock(() => {})

mock.module("./logger", () => ({
  log: logMock,
}))

const {
  checkProviderHealth,
  checkProvidersHealth,
  findFirstHealthyProvider,
  invalidateProviderHealth,
  invalidateAllProviderHealth,
  _resetForTesting,
} = await import(
  new URL(`./provider-health-check.ts?test=${Date.now()}-${Math.random()}`, import.meta.url).href
)

function createMockClient(connected: string[]) {
  return {
    provider: {
      list: mock(async () => ({
        data: {
          connected,
          all: connected.map((id) => ({ id, models: {} })),
        },
      })),
    },
  }
}

describe("provider-health-check", () => {
  beforeEach(() => {
    _resetForTesting()
    logMock.mockClear()
  })

  describe("checkProviderHealth", () => {
    test("#given connected provider #when checking health #then returns true", async () => {
      const client = createMockClient(["anthropic", "openai"])
      const result = await checkProviderHealth(client, "anthropic")
      expect(result).toBe(true)
    })

    test("#given disconnected provider #when checking health #then returns false", async () => {
      const client = createMockClient(["openai"])
      const result = await checkProviderHealth(client, "anthropic")
      expect(result).toBe(false)
    })

    test("#given cached healthy result #when checking again within TTL #then returns cached value without re-probing", async () => {
      const client = createMockClient(["anthropic"])
      await checkProviderHealth(client, "anthropic", { cacheTtlMs: 60_000 })
      await checkProviderHealth(client, "anthropic", { cacheTtlMs: 60_000 })
      // Only one call to provider.list
      expect(client.provider.list).toHaveBeenCalledTimes(1)
    })

    test("#given cached unhealthy result #when checking again within TTL #then returns cached false", async () => {
      const client = createMockClient(["openai"])
      const result1 = await checkProviderHealth(client, "anthropic", { cacheTtlMs: 60_000 })
      expect(result1).toBe(false)

      // Even if we "add" anthropic to a new client, cache should return false
      const client2 = createMockClient(["anthropic", "openai"])
      const result2 = await checkProviderHealth(client2, "anthropic", { cacheTtlMs: 60_000 })
      expect(result2).toBe(false)
      expect(client2.provider.list).not.toHaveBeenCalled()
    })

    test("#given expired cache #when checking health #then re-probes", async () => {
      const client = createMockClient(["anthropic"])
      await checkProviderHealth(client, "anthropic", { cacheTtlMs: 0 })
      await checkProviderHealth(client, "anthropic", { cacheTtlMs: 0 })
      expect(client.provider.list).toHaveBeenCalledTimes(2)
    })

    test("#given client.provider.list not available #when checking health #then returns true (assume healthy)", async () => {
      const client = { provider: {} } as any
      const result = await checkProviderHealth(client, "anthropic")
      expect(result).toBe(true)
    })

    test("#given provider.list throws error #when checking health #then returns true (assume healthy)", async () => {
      const client = {
        provider: {
          list: mock(async () => { throw new Error("ECONNREFUSED") }),
        },
      }
      const result = await checkProviderHealth(client, "anthropic")
      expect(result).toBe(true)
    })

    test("#given provider.list times out #when checking health with short timeout #then returns true", async () => {
      const client = {
        provider: {
          list: mock(() => new Promise(() => {})), // never resolves
        },
      }
      const result = await checkProviderHealth(client, "anthropic", { probeTimeoutMs: 50 })
      expect(result).toBe(true)
    })

    test("#given case-insensitive provider ID #when checking health #then matches correctly", async () => {
      const client = createMockClient(["Anthropic"])
      const result = await checkProviderHealth(client, "anthropic")
      expect(result).toBe(true)
    })
  })

  describe("checkProvidersHealth", () => {
    test("#given multiple providers #when checking health #then returns map of results", async () => {
      const client = createMockClient(["anthropic", "openai"])
      const results = await checkProvidersHealth(client, ["anthropic", "openai", "google"])
      expect(results.get("anthropic")).toBe(true)
      expect(results.get("openai")).toBe(true)
      expect(results.get("google")).toBe(false)
    })

    test("#given partially cached results #when checking health #then only probes uncached providers", async () => {
      const client = createMockClient(["anthropic", "openai"])
      // Prime cache for anthropic
      await checkProviderHealth(client, "anthropic", { cacheTtlMs: 60_000 })
      expect(client.provider.list).toHaveBeenCalledTimes(1)

      // Check both — should reuse cache for anthropic
      const results = await checkProvidersHealth(client, ["anthropic", "openai"], { cacheTtlMs: 60_000 })
      expect(results.get("anthropic")).toBe(true)
      expect(results.get("openai")).toBe(true)
      // One more call for the batch
      expect(client.provider.list).toHaveBeenCalledTimes(2)
    })

    test("#given all cached #when checking health #then skips probe entirely", async () => {
      const client = createMockClient(["anthropic"])
      await checkProvidersHealth(client, ["anthropic"], { cacheTtlMs: 60_000 })
      expect(client.provider.list).toHaveBeenCalledTimes(1)

      await checkProvidersHealth(client, ["anthropic"], { cacheTtlMs: 60_000 })
      // No additional calls
      expect(client.provider.list).toHaveBeenCalledTimes(1)
    })
  })

  describe("findFirstHealthyProvider", () => {
    test("#given first provider healthy #when finding #then returns first", async () => {
      const client = createMockClient(["anthropic", "openai"])
      const result = await findFirstHealthyProvider(client, ["anthropic", "openai"])
      expect(result).toBe("anthropic")
    })

    test("#given first provider unhealthy #when finding #then returns second", async () => {
      const client = createMockClient(["openai"])
      const result = await findFirstHealthyProvider(client, ["anthropic", "openai"])
      expect(result).toBe("openai")
    })

    test("#given all providers unhealthy #when finding #then returns null", async () => {
      const client = createMockClient([])
      const result = await findFirstHealthyProvider(client, ["anthropic", "openai"])
      expect(result).toBeNull()
    })

    test("#given empty provider list #when finding #then returns null", async () => {
      const client = createMockClient(["anthropic"])
      const result = await findFirstHealthyProvider(client, [])
      expect(result).toBeNull()
    })
  })

  describe("invalidateProviderHealth", () => {
    test("#given cached healthy result #when invalidating #then next check re-probes", async () => {
      const client = createMockClient(["anthropic"])
      await checkProviderHealth(client, "anthropic", { cacheTtlMs: 60_000 })
      expect(client.provider.list).toHaveBeenCalledTimes(1)

      invalidateProviderHealth("anthropic")

      await checkProviderHealth(client, "anthropic", { cacheTtlMs: 60_000 })
      expect(client.provider.list).toHaveBeenCalledTimes(2)
    })
  })

  describe("invalidateAllProviderHealth", () => {
    test("#given multiple cached results #when invalidating all #then all re-probe", async () => {
      const client = createMockClient(["anthropic", "openai"])
      await checkProvidersHealth(client, ["anthropic", "openai"], { cacheTtlMs: 60_000 })
      expect(client.provider.list).toHaveBeenCalledTimes(1)

      invalidateAllProviderHealth()

      await checkProvidersHealth(client, ["anthropic", "openai"], { cacheTtlMs: 60_000 })
      expect(client.provider.list).toHaveBeenCalledTimes(2)
    })
  })
})
