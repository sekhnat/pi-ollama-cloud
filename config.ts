/**
 * Configuration loader for pi-ollama-cloud.
 *
 * Reads settings from JSON config files with project-over-global precedence:
 *   - ~/.pi/agent/ollama-cloud.json (global / user-level)
 *   - .pi/ollama-cloud.json        (project-local, takes precedence)
 *
 * Environment variables serve as overrides above both config files:
 *   - PI_OLLAMA_WEB_TOOLS=0  disables web tool registration
 *   - PI_OLLAMA_USAGE_DISPLAY=sidebar|statusbar|off  overrides the usage display
 *
 * Example ollama-cloud.json:
 * ```json
 * {
 *   "webTools": false
 * }
 * ```
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// --- Types ---

export interface OllamaCloudConfig {
  /** When false, ollama_web_search and ollama_web_fetch tools are not registered. Default: true. */
  webTools?: boolean;
  /** Legacy boolean for the footer usage status bar: true maps to statusbar, false to off. */
  usageStatus?: boolean;
  /** Where usage is displayed: sidebar panel (default), statusbar, or off. Overrides usageStatus. */
  usageDisplay?: UsageDisplay;
}

/** Where the Ollama Cloud usage display renders. */
export type UsageDisplay = "sidebar" | "statusbar" | "off";

// --- Defaults ---

const DEFAULT_CONFIG: OllamaCloudConfig = {
  webTools: true,
  // usageStatus and usageDisplay are intentionally absent: an unset key must
  // stay undefined so resolveUsageDisplay can tell "no explicit setting"
  // (sidebar default) apart from a legacy `usageStatus: false` (off).
};

// --- Validation ---

const USAGE_DISPLAY_VALUES = new Set(["sidebar", "statusbar", "off"]);

/** Allowed config keys and their expected runtime types for validation. */
const CONFIG_SCHEMA: Record<keyof OllamaCloudConfig, "boolean" | "usageDisplay"> = {
  webTools: "boolean",
  usageStatus: "boolean",
  usageDisplay: "usageDisplay",
};

function isValidConfigValue(value: unknown, expectedType: string): boolean {
  if (expectedType === "usageDisplay") {
    return typeof value === "string" && USAGE_DISPLAY_VALUES.has(value);
  }
  return typeof value === expectedType;
}

/** Human description of an expected config value, for warning messages. */
function expectedValueDescription(expectedType: string): string {
  return expectedType === "usageDisplay" ? `"sidebar", "statusbar", or "off"` : "a boolean";
}

/**
 * Validate a parsed JSON object against the known schema.
 * Unknown keys and values with wrong types are dropped, each with a warning
 * naming the offending key so typos (e.g. "webtools") surface instead of
 * silently applying defaults. null means explicitly unset and is skipped
 * without a warning.
 */
function sanitizeConfig(raw: Record<string, unknown>, source: string): OllamaCloudConfig {
  const out: OllamaCloudConfig = {};
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(CONFIG_SCHEMA, key)) {
      console.warn(
        `[pi-ollama-cloud] Unknown config key "${key}" in ${source}; ignoring it. ` +
          `Valid keys: ${Object.keys(CONFIG_SCHEMA).join(", ")}.`,
      );
    }
  }
  for (const [key, expectedType] of Object.entries(CONFIG_SCHEMA)) {
    const value = raw[key];
    if (value === null || value === undefined) continue;
    if (isValidConfigValue(value, expectedType)) {
      (out as Record<string, unknown>)[key] = value;
    } else {
      console.warn(
        `[pi-ollama-cloud] Invalid value for "${key}" in ${source} ` +
          `(expected ${expectedValueDescription(expectedType)}); ignoring it.`,
      );
    }
  }
  return out;
}

/**
 * Resolve the effective usage display from merged config.
 * Precedence: explicit usageDisplay, then legacy usageStatus
 * (true -> statusbar, false -> off), then the sidebar default.
 */
export function resolveUsageDisplay(config: OllamaCloudConfig): UsageDisplay {
  if (config.usageDisplay !== undefined) return config.usageDisplay;
  if (config.usageStatus === true) return "statusbar";
  if (config.usageStatus === false) return "off";
  return "sidebar";
}

// --- Loader ---

/**
 * Load configuration from JSON files.
 * Project-local config overrides global config.
 * Environment variables override both.
 */
export function loadConfig(cwd: string): OllamaCloudConfig {
  const globalPath = join(getAgentDir(), "ollama-cloud.json");
  const projectPath = join(cwd, ".pi", "ollama-cloud.json");

  let globalConfig: OllamaCloudConfig = {};
  let projectConfig: OllamaCloudConfig = {};

  // Load global config
  if (existsSync(globalPath)) {
    try {
      const content = readFileSync(globalPath, "utf-8");
      const parsed = JSON.parse(content);
      // Silently skip files that parse to null, arrays, or primitives —
      // malformed config should not crash the extension (defaults apply).
      if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
        globalConfig = sanitizeConfig(parsed as Record<string, unknown>, globalPath);
      }
    } catch (err) {
      console.error(`[pi-ollama-cloud] Failed to load config from ${globalPath}: ${err}`);
    }
  }

  // Load project config
  if (existsSync(projectPath)) {
    try {
      const content = readFileSync(projectPath, "utf-8");
      const parsed = JSON.parse(content);
      // Same guard as global config: null/array/primitive parses are ignored.
      if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
        projectConfig = sanitizeConfig(parsed as Record<string, unknown>, projectPath);
      }
    } catch (err) {
      console.error(`[pi-ollama-cloud] Failed to load config from ${projectPath}: ${err}`);
    }
  }

  // Merge with defaults: defaults < global < project
  const merged: OllamaCloudConfig = {
    ...DEFAULT_CONFIG,
    ...globalConfig,
    ...projectConfig,
  };

  // Environment variable overrides
  const envOverride = resolveWebToolsEnv();
  if (envOverride !== undefined) {
    merged.webTools = envOverride;
  }
  const envUsageDisplay = resolveUsageDisplayEnv();
  if (envUsageDisplay !== undefined) {
    merged.usageDisplay = envUsageDisplay;
  }

  return merged;
}

/**
 * Resolve the PI_OLLAMA_USAGE_DISPLAY environment variable override.
 * Returns undefined when unset or blank, the mode when valid, and undefined
 * (with a warning) for any other value.
 */
export function resolveUsageDisplayEnv(): UsageDisplay | undefined {
  const raw = process.env.PI_OLLAMA_USAGE_DISPLAY;
  if (raw === undefined) return undefined;
  const lowered = raw.trim().toLowerCase();
  if (lowered === "") return undefined;
  if (USAGE_DISPLAY_VALUES.has(lowered)) return lowered as UsageDisplay;
  console.warn(
    `[pi-ollama-cloud] Ignoring PI_OLLAMA_USAGE_DISPLAY="${raw}": expected "sidebar", "statusbar", or "off".`,
  );
  return undefined;
}

/**
 * Resolve the PI_OLLAMA_WEB_TOOLS environment variable override.
 * Returns undefined when not set (no override),
 * true/false when explicitly set.
 */
export function resolveWebToolsEnv(): boolean | undefined {
  const raw = process.env.PI_OLLAMA_WEB_TOOLS;
  if (raw === undefined) return undefined;

  const lowered = raw.toLowerCase();
  if (["0", "false", "no", "off", ""].includes(lowered)) return false;
  // Treat any other non-empty value as "enabled"
  return true;
}
