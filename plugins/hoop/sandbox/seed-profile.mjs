#!/usr/bin/env node
// Seed the sandbox Claude profile — idempotent, runs on every boot as `agent`
// from the container entrypoint.
//
// This is the in-container port of the wiring that used to run on the HOST via
// jq (cli/lib/stack.sh: _hs_seed_claude_json + _hs_ensure_plugin_enabled).
// Moving it here means the host needs no jq: Node is baked into this image, jq
// is not. It ensures, without clobbering a logged-in identity:
//   1. .claude.json bypasses claude's first-run onboarding prompts.
//   2. the baked hoop plugin (/opt/hoop) is installed + enabled.
//   3. the SANDBOX-ONLY hook wiring (permission gate + event emitters) is set.
//   4. @playwright/mcp's RCE-equivalent tool is denied at claude's own layer.
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const HOME = process.env.HOME || homedir() || "/home/agent";
const CLAUDE_DIR = join(HOME, ".claude");
const PLUGIN_KEY = "hoop@workspace";
const INSTALL_PATH = "/opt/hoop";
const DENY_PW_UNSAFE = "mcp__playwright__browser_run_code_unsafe";

// `uv tool install serena-agent` (an optional catalog/code-graph.md pick) lands
// its console-script shims in ~/.local/bin, already on PATH (Dockerfile). Its
// presence — not a persisted wizard flag — gates the Serena hooks below, so
// this self-heals the same way regardless of how Serena was installed/removed.
const SERENA_HOOKS_BIN = join(HOME, ".local/bin/serena-hooks");
const hasSerenaHooks = existsSync(SERENA_HOOKS_BIN);
const serenaHook = (sub, timeout) => ({
  type: "command",
  command: `${SERENA_HOOKS_BIN} ${sub} --client=claude-code`,
  timeout,
});

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};
// Returns true if the file was written, false if it's a read-only mount we
// intentionally leave alone. `hoop open` overlays its OWN stripped
// settings.json as a `:ro` bind mount (dashboard hooks + hoop plugin removed,
// since they need the dashboard socket that doesn't exist in an `open`
// session). That mount surfaces as EROFS here — respect it rather than crash.
// Only EROFS is swallowed; EACCES and friends still throw so a real
// ownership/permission bug in the dashboard sandbox stays loud.
const writeJson = (p, obj, mode) => {
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
  } catch (e) {
    if (e && e.code === "EROFS") {
      console.log(`[seed] ${p} is a read-only mount — leaving it as-is`);
      return false;
    }
    throw e;
  }
  if (mode) {
    try {
      chmodSync(p, mode);
    } catch {
      /* best-effort on grpcfuse */
    }
  }
  return true;
};

// 1) .claude.json — bypass onboarding. Merge-safe: preserves oauthAccount,
//    mcpServers, projects, etc. so a logged-in profile is never clobbered.
const cjPath = join(HOME, ".claude.json");
const cj = readJson(cjPath) || {};
if (cj.hasCompletedOnboarding !== true) {
  cj.hasCompletedOnboarding = true;
  writeJson(cjPath, cj, 0o600);
  console.log("[seed] onboarding-bypass set in .claude.json");
}

// 2) installed_plugins.json — register the baked hoop plugin (idempotent).
const ipPath = join(CLAUDE_DIR, "plugins", "installed_plugins.json");
const ip = readJson(ipPath) || {};
ip.version = ip.version || 2;
ip.plugins = ip.plugins || {};
if (!ip.plugins[PLUGIN_KEY]) {
  ip.plugins[PLUGIN_KEY] = [{ scope: "user", installPath: INSTALL_PATH, version: "0.1.0" }];
  writeJson(ipPath, ip);
  console.log(`[seed] registered ${PLUGIN_KEY} -> ${INSTALL_PATH}`);
}

// 3) settings.json — enable the plugin, deny the RCE tool, wire sandbox hooks.
//    Hooks are declared HERE (not in the plugin manifest) so the host never
//    runs them. Set unconditionally so the wiring self-heals every boot.
const sPath = join(CLAUDE_DIR, "settings.json");
const s = readJson(sPath) || {};
s.enabledPlugins = s.enabledPlugins || {};
s.enabledPlugins[PLUGIN_KEY] = true;
s.permissions = s.permissions || {};
s.permissions.deny = s.permissions.deny || [];
if (!s.permissions.deny.includes(DENY_PW_UNSAFE)) s.permissions.deny.push(DENY_PW_UNSAFE);
const emit = (evt) => ({
  hooks: [{ type: "command", command: `/opt/hoop/hooks/scripts/emit-event.sh ${evt}`, timeout: 5 }],
});
const preToolUseHooks = [
  { type: "command", command: "/opt/hoop/hooks/scripts/permission-gate.sh", timeout: 130 },
  { type: "command", command: "/opt/hoop/hooks/scripts/emit-event.sh PreToolUse", timeout: 5 },
];
const sessionStartHooks = [emit("SessionStart").hooks[0]];
// permission-gate.sh remains the SOLE thing that can grant/approve a tool
// call (it backs /plan + pairing-review). serena-hooks remind only ever adds
// friction (a soft PreToolUse block via exit code), never approves, so it
// can't bypass that gate — unlike Serena's own `auto-approve` hook, which we
// deliberately never wire here for that reason.
if (hasSerenaHooks) {
  preToolUseHooks.push(serenaHook("remind", 10));
  sessionStartHooks.push(serenaHook("activate", 20));
}
s.hooks = {
  PreToolUse: [{ hooks: preToolUseHooks }],
  PostToolUse: [emit("PostToolUse")],
  SessionStart: [{ hooks: sessionStartHooks }],
  Stop: [emit("Stop")],
  UserPromptSubmit: [emit("UserPromptSubmit")],
};
if (hasSerenaHooks) {
  s.hooks.SessionEnd = [{ hooks: [serenaHook("cleanup", 20)] }];
}
if (writeJson(sPath, s)) {
  try {
    chmodSync(CLAUDE_DIR, 0o700);
  } catch {
    /* best-effort */
  }
  console.log("[seed] hoop plugin enabled + hooks wired in the sandbox profile");
  if (hasSerenaHooks) {
    console.log("[seed] serena-hooks detected — wired activate/remind/cleanup (auto-approve intentionally excluded)");
  }
}
