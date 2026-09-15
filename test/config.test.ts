import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type OllamaCloudConfig, resolveUsageDisplay, resolveUsageDisplayEnv } from "../config.ts";

describe("resolveUsageDisplay", () => {
  it("defaults to sidebar when neither key is set", () => {
    expect(resolveUsageDisplay({})).toBe("sidebar");
    expect(resolveUsageDisplay({ webTools: true })).toBe("sidebar");
  });

  it("maps the legacy usageStatus boolean", () => {
    expect(resolveUsageDisplay({ usageStatus: true })).toBe("statusbar");
    expect(resolveUsageDisplay({ usageStatus: false })).toBe("off");
  });

  it("prefers an explicit usageDisplay over the legacy boolean", () => {
    expect(resolveUsageDisplay({ usageStatus: true, usageDisplay: "off" })).toBe("off");
    expect(resolveUsageDisplay({ usageStatus: false, usageDisplay: "sidebar" })).toBe("sidebar");
    expect(resolveUsageDisplay({ usageStatus: true, usageDisplay: "statusbar" })).toBe("statusbar");
  });

  it("passes each explicit mode through", () => {
    for (const mode of ["sidebar", "statusbar", "off"] as const) {
      expect(resolveUsageDisplay({ usageDisplay: mode })).toBe(mode);
    }
  });
});

function spyWarn() {
  return vi.spyOn(console, "warn").mockImplementation(() => {});
}

describe("config files", () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalWebToolsEnv = process.env.PI_OLLAMA_WEB_TOOLS;
  const originalUsageDisplayEnv = process.env.PI_OLLAMA_USAGE_DISPLAY;
  let warn: ReturnType<typeof spyWarn>;
  let agentDir = "";
  let projectDir = "";

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "ollama-agentdir-"));
    projectDir = mkdtempSync(join(tmpdir(), "ollama-config-"));
    // Isolate the global config dir and env overrides so assertions do not
    // depend on the developer machine's ~/.pi/agent/ollama-cloud.json.
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.PI_OLLAMA_WEB_TOOLS;
    delete process.env.PI_OLLAMA_USAGE_DISPLAY;
    warn = spyWarn();
  });

  afterEach(() => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (originalWebToolsEnv === undefined) delete process.env.PI_OLLAMA_WEB_TOOLS;
    else process.env.PI_OLLAMA_WEB_TOOLS = originalWebToolsEnv;
    if (originalUsageDisplayEnv === undefined) delete process.env.PI_OLLAMA_USAGE_DISPLAY;
    else process.env.PI_OLLAMA_USAGE_DISPLAY = originalUsageDisplayEnv;
    warn.mockRestore();
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  function writeGlobalConfig(config: Record<string, unknown>) {
    writeFileSync(join(agentDir, "ollama-cloud.json"), JSON.stringify(config));
  }

  function writeProjectConfig(config: Record<string, unknown>) {
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(join(projectDir, ".pi", "ollama-cloud.json"), JSON.stringify(config));
  }

  it("drops invalid usageDisplay values instead of crashing", () => {
    writeProjectConfig({ usageDisplay: "bogus", usageStatus: true });
    const config: OllamaCloudConfig = loadConfig(projectDir);
    expect(config.usageDisplay).toBeUndefined();
    expect(config.usageStatus).toBe(true);
    expect(resolveUsageDisplay(config)).toBe("statusbar");
  });

  it("warns on unknown keys and drops them", () => {
    writeProjectConfig({ webtools: false, webTools: false });
    const config = loadConfig(projectDir);
    // The typo'd key is dropped; the valid key still applies.
    expect(config.webTools).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("webtools"));
  });

  it("warns on invalid values for known keys and drops them", () => {
    writeProjectConfig({ usageDisplay: "bogus" });
    const config = loadConfig(projectDir);
    expect(config.usageDisplay).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("usageDisplay"));
  });

  it("stays silent for valid config and treats null as unset", () => {
    writeProjectConfig({ webTools: false, usageDisplay: "off", usageStatus: null });
    const config = loadConfig(projectDir);
    expect(config.webTools).toBe(false);
    expect(config.usageDisplay).toBe("off");
    expect(config.usageStatus).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("prefers project-local over global config", () => {
    writeGlobalConfig({ webTools: true });
    writeProjectConfig({ webTools: false });
    expect(loadConfig(projectDir).webTools).toBe(false);
  });

  it("PI_OLLAMA_USAGE_DISPLAY overrides both config files", () => {
    writeGlobalConfig({ usageDisplay: "off" });
    writeProjectConfig({ usageDisplay: "sidebar" });
    process.env.PI_OLLAMA_USAGE_DISPLAY = "statusbar";
    expect(resolveUsageDisplay(loadConfig(projectDir))).toBe("statusbar");
  });

  it("falls back to config files when PI_OLLAMA_USAGE_DISPLAY is invalid", () => {
    writeProjectConfig({ usageDisplay: "statusbar" });
    process.env.PI_OLLAMA_USAGE_DISPLAY = "banana";
    expect(resolveUsageDisplay(loadConfig(projectDir))).toBe("statusbar");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("PI_OLLAMA_USAGE_DISPLAY"));
  });
});

describe("resolveUsageDisplayEnv", () => {
  const original = process.env.PI_OLLAMA_USAGE_DISPLAY;
  let warn: ReturnType<typeof spyWarn>;

  beforeEach(() => {
    delete process.env.PI_OLLAMA_USAGE_DISPLAY;
    warn = spyWarn();
  });

  afterEach(() => {
    if (original === undefined) delete process.env.PI_OLLAMA_USAGE_DISPLAY;
    else process.env.PI_OLLAMA_USAGE_DISPLAY = original;
    warn.mockRestore();
  });

  it("returns undefined when unset or blank", () => {
    expect(resolveUsageDisplayEnv()).toBeUndefined();
    process.env.PI_OLLAMA_USAGE_DISPLAY = "  ";
    expect(resolveUsageDisplayEnv()).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("maps valid values, trimming and lowercasing", () => {
    process.env.PI_OLLAMA_USAGE_DISPLAY = "sidebar";
    expect(resolveUsageDisplayEnv()).toBe("sidebar");
    process.env.PI_OLLAMA_USAGE_DISPLAY = " StatusBar ";
    expect(resolveUsageDisplayEnv()).toBe("statusbar");
    process.env.PI_OLLAMA_USAGE_DISPLAY = "off";
    expect(resolveUsageDisplayEnv()).toBe("off");
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns and returns undefined for invalid values", () => {
    process.env.PI_OLLAMA_USAGE_DISPLAY = "banana";
    expect(resolveUsageDisplayEnv()).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("PI_OLLAMA_USAGE_DISPLAY"));
  });
});
