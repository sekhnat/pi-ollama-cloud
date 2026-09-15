import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ollamaExtension from "../index.ts";
import { resetSidebarRevisionsForTest } from "../sidebar.ts";

/**
 * Wiring coverage for the usage display fan-out. The extension factory runs
 * against a stub ExtensionAPI; a compatible-host discovery flips the publisher
 * so subsequent refreshes route to the sidebar, and the footer key clears.
 */

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;

let projectDir = "";

function makePi() {
  const busHandlers = new Set<(data: unknown) => void>();
  const eventHandlers = new Map<string, Set<Handler>>();
  const emitted: Array<Record<string, unknown>> = [];
  const statuses = new Map<string, string | undefined>();
  const events = {
    on: (_channel: string, handler: (data: unknown) => void) => {
      busHandlers.add(handler);
      return () => busHandlers.delete(handler);
    },
    emit: (channel: string, data: unknown) => {
      void channel;
      emitted.push(data as Record<string, unknown>);
      for (const handler of [...busHandlers]) handler(data);
    },
  };
  const pi = {
    events,
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    registerTool: vi.fn(),
    getAllTools: vi.fn(() => []),
    getActiveTools: vi.fn(() => []),
    setActiveTools: vi.fn(),
    on: (event: string, handler: Handler) => {
      const set = eventHandlers.get(event) ?? new Set<Handler>();
      set.add(handler);
      eventHandlers.set(event, set);
    },
    setModel: vi.fn(),
  };
  const ctx = {
    mode: "tui" as string,
    cwd: projectDir,
    model: { provider: "ollama-cloud" },
    modelRegistry: { getApiKeyForProvider: async () => "test-key" },
    sessionManager: { getBranch: () => [] },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: (key: string, value: string | undefined) => {
        statuses.set(key, value);
      },
    },
  };
  return { pi, emitted, eventHandlers, busHandlers, statuses, ctx };
}

const usageBody = {
  limits: { session: { usage: 0.4, models: [{ name: "a", request_count: 2 }] } },
};

async function startSession(h: Awaited<ReturnType<typeof makePi>>) {
  for (const handler of h.eventHandlers.get("session_start") ?? []) {
    await handler(null, h.ctx);
  }
}

function discover(h: ReturnType<typeof makePi>, capabilities: string[] | undefined) {
  for (const handler of [...h.busHandlers]) {
    handler({ version: 1, type: "discover", requestId: "atelier-1", ...(capabilities ? { capabilities } : {}) });
  }
}

const registers = (emitted: Array<Record<string, unknown>>) => emitted.filter((event) => event.type === "register");
const unregisters = (emitted: Array<Record<string, unknown>>) => emitted.filter((event) => event.type === "unregister");

describe("usage display fan-out", () => {
  beforeEach(() => {
    resetSidebarRevisionsForTest();
    globalThis.fetch = async () =>
      new Response(JSON.stringify(usageBody), { status: 200, headers: { "Content-Type": "application/json" } });
    // Isolate from the developer's real user config: write a project config
    // with the sidebar default (project overrides global in loadConfig).
    projectDir = mkdtempSync(join(tmpdir(), "ollama-fanout-"));
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(join(projectDir, ".pi", "ollama-cloud.json"), JSON.stringify({ usageDisplay: "sidebar" }));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("routes valid data to the sidebar and clears the footer key with a compatible host", async () => {
    const h = makePi();
    await ollamaExtension(h.pi as never);
    discover(h, ["panel-defaults-v1"]);
    await startSession(h);
    await vi.waitFor(() => expect(registers(h.emitted).length).toBeGreaterThan(0));
    const first = registers(h.emitted).at(-1);
    expect(first).toMatchObject({ type: "register", source: "ollama-cloud", panel: { id: "ollama-cloud:usage" } });
    expect(h.statuses.get("ollama-usage")).toBeUndefined();
  });

  it("falls back to the footer status without a compatible host", async () => {
    const h = makePi();
    await ollamaExtension(h.pi as never);
    discover(h, undefined);
    await startSession(h);
    await vi.waitFor(() => expect(h.statuses.get("ollama-usage")).toBeDefined());
    expect(registers(h.emitted)).toHaveLength(0);
    expect(h.statuses.get("ollama-usage")).toContain("5h");
  });

  it("withdraws the panel on fetch failure without notifying", async () => {
    globalThis.fetch = async () => new Response("boom", { status: 500 });
    const h = makePi();
    await ollamaExtension(h.pi as never);
    discover(h, ["panel-defaults-v1"]);
    await startSession(h);
    // A failing endpoint never publishes and never notifies; both destinations
    // stay clear and the timer retries on the next cooldown.
    await vi.waitFor(() => expect(h.statuses.get("ollama-usage")).toBeUndefined());
    expect(registers(h.emitted)).toHaveLength(0);
    expect(unregisters(h.emitted)).toHaveLength(0);
  });

  it("never runs display work in non-TUI modes", async () => {
    const h = makePi();
    (h.ctx as { mode: string }).mode = "print";
    await ollamaExtension(h.pi as never);
    discover(h, ["panel-defaults-v1"]);
    await startSession(h);
    // The refresh loop is timer-driven; a session_start in non-TUI must not
    // start it, so no register, no status, and no timer exists to fire later.
    expect(registers(h.emitted)).toHaveLength(0);
    expect(h.statuses.get("ollama-usage")).toBeUndefined();
  });

  it("unsubscribes the sidebar publisher on session_shutdown", async () => {
    const h = makePi();
    await ollamaExtension(h.pi as never);
    discover(h, ["panel-defaults-v1"]);
    await startSession(h);
    await vi.waitFor(() => expect(registers(h.emitted).length).toBeGreaterThan(0));
    expect(h.busHandlers.size).toBe(1);

    for (const handler of h.eventHandlers.get("session_shutdown") ?? []) {
      await handler(null, h.ctx);
    }
    // The publisher withdrew the panel and tore down its bus subscription.
    expect(unregisters(h.emitted)).toHaveLength(1);
    expect(h.busHandlers.size).toBe(0);
    // A later discovery must not re-register the panel from the disposed instance.
    discover(h, ["panel-defaults-v1"]);
    expect(registers(h.emitted).length).toBe(1);
  });

  it("a re-invoked factory publishes again with a strictly higher revision", async () => {
    const first = makePi();
    await ollamaExtension(first.pi as never);
    discover(first, ["panel-defaults-v1"]);
    await startSession(first);
    await vi.waitFor(() => expect(registers(first.emitted).length).toBeGreaterThan(0));
    const firstRevision = registers(first.emitted).at(-1)?.revision as number;
    for (const handler of first.eventHandlers.get("session_shutdown") ?? []) {
      await handler(null, first.ctx);
    }

    // Simulated factory re-invocation (pi rebinds extensions after a session
    // switch): the new instance subscribes fresh, and its revisions continue
    // from the shared module-level clock.
    const second = makePi();
    await ollamaExtension(second.pi as never);
    discover(second, ["panel-defaults-v1"]);
    await startSession(second);
    await vi.waitFor(() => expect(registers(second.emitted).length).toBeGreaterThan(0));
    const secondRevision = registers(second.emitted).at(-1)?.revision as number;
    expect(secondRevision).toBeGreaterThan(firstRevision);
  });
});
