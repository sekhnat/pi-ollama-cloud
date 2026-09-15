import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ollamaExtension, { resolveUsageStatusToggle } from "../index.ts";

describe("resolveUsageStatusToggle", () => {
  it("enables to sidebar on 'on', 'enable', and 'sidebar'", () => {
    expect(resolveUsageStatusToggle("on", "off")).toEqual({ mode: "sidebar" });
    expect(resolveUsageStatusToggle("enable", "off")).toEqual({ mode: "sidebar" });
    expect(resolveUsageStatusToggle("sidebar", "statusbar")).toEqual({ mode: "sidebar" });
  });

  it("selects statusbar explicitly", () => {
    expect(resolveUsageStatusToggle("statusbar", "sidebar")).toEqual({ mode: "statusbar" });
  });

  it("disables on 'off' and 'disable'", () => {
    expect(resolveUsageStatusToggle("off", "sidebar")).toEqual({ mode: "off" });
    expect(resolveUsageStatusToggle("disable", "statusbar")).toEqual({ mode: "off" });
  });

  it("toggles between sidebar and off from every current mode", () => {
    expect(resolveUsageStatusToggle("", "sidebar")).toEqual({ mode: "off" });
    expect(resolveUsageStatusToggle("", "statusbar")).toEqual({ mode: "off" });
    expect(resolveUsageStatusToggle("", "off")).toEqual({ mode: "sidebar" });
  });

  it("is case-insensitive and trims surrounding whitespace", () => {
    expect(resolveUsageStatusToggle("  ON  ", "off")).toEqual({ mode: "sidebar" });
    expect(resolveUsageStatusToggle("SIDEBAR", "off")).toEqual({ mode: "sidebar" });
  });

  it("returns an error for unknown arguments, keeping the current state", () => {
    const result = resolveUsageStatusToggle("bogus", "statusbar");
    expect(result.mode).toBe("statusbar");
    expect(result.error).toContain("Unknown argument");
    expect(result.error).toContain("sidebar");
  });

  it("restores the last enabled mode when toggling back on", () => {
    expect(resolveUsageStatusToggle("", "off", "statusbar")).toEqual({ mode: "statusbar" });
    expect(resolveUsageStatusToggle("", "off", "sidebar")).toEqual({ mode: "sidebar" });
  });

  it("restores the last enabled mode on 'on' and 'enable' from off", () => {
    expect(resolveUsageStatusToggle("on", "off", "statusbar")).toEqual({ mode: "statusbar" });
    expect(resolveUsageStatusToggle("enable", "off", "statusbar")).toEqual({ mode: "statusbar" });
  });

  it("'on' while already enabled keeps the current mode instead of switching to the sidebar", () => {
    expect(resolveUsageStatusToggle("on", "statusbar", "sidebar")).toEqual({ mode: "statusbar" });
    expect(resolveUsageStatusToggle("enable", "sidebar", "statusbar")).toEqual({ mode: "sidebar" });
  });

  it("toggling off from an enabled mode ignores the last enabled mode", () => {
    expect(resolveUsageStatusToggle("", "statusbar", "sidebar")).toEqual({ mode: "off" });
    expect(resolveUsageStatusToggle("", "sidebar", "statusbar")).toEqual({ mode: "off" });
  });
});

// --- Command-level wiring ----------------------------------------------------

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;

interface CommandDef {
  handler: (args: string, ctx: unknown) => Promise<void>;
}

/**
 * Minimal stub shaped like usage-fanout.test.ts's makePi: the factory registers
 * its commands and session handlers; the test drives the /ollama-usage-status
 * handler through a full toggle cycle. Print mode keeps the usage display
 * machinery (timers, panels) out of the picture.
 */
function makePi(cwd: string) {
  const eventHandlers = new Map<string, Set<Handler>>();
  const pi = {
    events: { on: vi.fn(() => () => {}), emit: vi.fn() },
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
    getAllTools: vi.fn(() => []),
    getActiveTools: vi.fn(() => []),
    setActiveTools: vi.fn(),
    on: (event: string, handler: Handler) => {
      const set = eventHandlers.get(event) ?? new Set<Handler>();
      set.add(handler);
      eventHandlers.set(event, set);
    },
  };
  const notify = vi.fn();
  const ctx = {
    mode: "print",
    cwd,
    model: { provider: "ollama-cloud" },
    modelRegistry: { getApiKeyForProvider: async () => "test-key" },
    ui: {
      notify,
      setStatus: vi.fn(),
      theme: { fg: (_color: string, text: string) => text },
    },
  };
  return { pi, eventHandlers, ctx, notify };
}

describe("/ollama-usage-status command", () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalWebToolsEnv = process.env.PI_OLLAMA_WEB_TOOLS;
  const originalUsageDisplayEnv = process.env.PI_OLLAMA_USAGE_DISPLAY;
  let projectDir = "";
  let agentDir = "";

  beforeEach(() => {
    // Isolate config: no global ollama-cloud.json, no env overrides, and a
    // project dir with no .pi/ollama-cloud.json (the sidebar default applies).
    projectDir = mkdtempSync(join(tmpdir(), "ollama-usagecmd-"));
    agentDir = mkdtempSync(join(tmpdir(), "ollama-agentdir-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.PI_OLLAMA_WEB_TOOLS;
    delete process.env.PI_OLLAMA_USAGE_DISPLAY;
  });

  afterEach(() => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (originalWebToolsEnv === undefined) delete process.env.PI_OLLAMA_WEB_TOOLS;
    else process.env.PI_OLLAMA_WEB_TOOLS = originalWebToolsEnv;
    if (originalUsageDisplayEnv === undefined) delete process.env.PI_OLLAMA_USAGE_DISPLAY;
    else process.env.PI_OLLAMA_USAGE_DISPLAY = originalUsageDisplayEnv;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  async function startSessionAndFindCommand(h: ReturnType<typeof makePi>) {
    await ollamaExtension(h.pi as never);
    for (const handler of h.eventHandlers.get("session_start") ?? []) {
      await handler(null, h.ctx);
    }
    const calls = h.pi.registerCommand.mock.calls as Array<[string, CommandDef]>;
    return calls.find(([name]) => name === "ollama-usage-status")?.[1];
  }

  it("restores the mode selected before off when toggling with no argument", async () => {
    const h = makePi(projectDir);
    const def = await startSessionAndFindCommand(h);
    expect(def).toBeDefined();

    await def!.handler("statusbar", h.ctx);
    await def!.handler("off", h.ctx);
    await def!.handler("", h.ctx);

    expect(h.notify).toHaveBeenNthCalledWith(1, "Ollama Cloud usage display: statusbar", "info");
    expect(h.notify).toHaveBeenNthCalledWith(2, "Ollama Cloud usage display: off", "info");
    // The bare toggle restores statusbar instead of the sidebar default.
    expect(h.notify).toHaveBeenNthCalledWith(3, "Ollama Cloud usage display: statusbar", "info");
  });

  it("toggles back to the sidebar default when nothing was enabled this session", async () => {
    const h = makePi(projectDir);
    const def = await startSessionAndFindCommand(h);

    await def!.handler("off", h.ctx);
    await def!.handler("", h.ctx);

    expect(h.notify).toHaveBeenNthCalledWith(1, "Ollama Cloud usage display: off", "info");
    expect(h.notify).toHaveBeenNthCalledWith(
      2,
      "Ollama Cloud usage display: sidebar panel (statusbar fallback without Pi Atelier)",
      "info",
    );
  });
});
