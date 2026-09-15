import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { envInt, getCloudApiKey, httpError } from "../utils.ts";

// --- Helpers ---

/**
 * Build a fake ExtensionContext whose modelRegistry.getApiKeyForProvider
 * returns the given key.
 */
function fakeCtx(storedKey: string | undefined): Pick<ExtensionContext, "modelRegistry"> {
  return {
    modelRegistry: {
      getApiKeyForProvider: async (_provider: string) => storedKey,
    } as unknown as ModelRegistry,
  };
}

// ============================================================================
// getCloudApiKey
// ============================================================================

describe("getCloudApiKey", () => {
  const originalEnv = process.env.OLLAMA_API_KEY;

  beforeEach(() => {
    delete process.env.OLLAMA_API_KEY;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = originalEnv;
  });

  it("returns the stored key when getApiKeyForProvider resolves one", async () => {
    const apiKey = await getCloudApiKey(fakeCtx("stored-key"));
    expect(apiKey).toBe("stored-key");
  });

  it("falls back to OLLAMA_API_KEY env var when no stored key is resolved (#24 regression)", async () => {
    process.env.OLLAMA_API_KEY = "env-key";
    const apiKey = await getCloudApiKey(fakeCtx(undefined));
    expect(apiKey).toBe("env-key");
  });

  it("returns undefined when neither a stored key nor the env var is set", async () => {
    const apiKey = await getCloudApiKey(fakeCtx(undefined));
    expect(apiKey).toBeUndefined();
  });

  it("prefers the stored key over the OLLAMA_API_KEY env var", async () => {
    process.env.OLLAMA_API_KEY = "env-key";
    const apiKey = await getCloudApiKey(fakeCtx("stored-key"));
    expect(apiKey).toBe("stored-key");
  });
});

// ============================================================================
// httpError
// ============================================================================

describe("httpError", () => {
  it("throws an auth error on 401", () => {
    expect(() => httpError("usage", 401)).toThrow(/authentication error/);
  });

  it("throws an auth error on 403", () => {
    expect(() => httpError("usage", 403)).toThrow(/authentication error/);
  });

  it("throws a rate-limit error on 429", () => {
    expect(() => httpError("usage", 429)).toThrow(/rate limited/);
  });

  it("throws a server error on 5xx", () => {
    expect(() => httpError("usage", 500)).toThrow(/server error/);
  });

  it("throws an unexpected-response error on other statuses", () => {
    expect(() => httpError("usage", 400)).toThrow(/unexpected response/);
  });

  it("includes the operation name in the message", () => {
    expect(() => httpError("search", 500)).toThrow(/search failed/);
  });

  it("includes the server error body when present", () => {
    expect(() => httpError("usage", 400, "bad request")).toThrow(/bad request/);
  });
});

// ============================================================================
// envInt
// ============================================================================

describe("envInt", () => {
  const NAME = "PI_OLLAMA_UNIT_TEST_INT";

  afterEach(() => {
    delete process.env[NAME];
  });

  it("returns the fallback when unset or blank", () => {
    expect(envInt(NAME, 24)).toBe(24);
    process.env[NAME] = "";
    expect(envInt(NAME, 24)).toBe(24);
    process.env[NAME] = "  ";
    expect(envInt(NAME, 24)).toBe(24);
  });

  it("parses a non-negative integer", () => {
    process.env[NAME] = "7";
    expect(envInt(NAME, 24)).toBe(7);
  });

  it("accepts 0 so cache-disabling values work (e.g. a TTL of 0)", () => {
    process.env[NAME] = "0";
    expect(envInt(NAME, 24)).toBe(0);
  });

  it("falls back on non-integers, negatives, and garbage", () => {
    for (const bad of ["abc", "3.5", "-1"]) {
      process.env[NAME] = bad;
      expect(envInt(NAME, 24)).toBe(24);
    }
  });
});
