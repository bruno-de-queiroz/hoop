import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Return every plugin directory that claude subprocesses should `--plugin-dir`
 * onto. Two sources:
 *   1. The hoop runtime itself — mounted read-only at
 *      HOOP_PLUGIN_ROOT inside the sandbox container (default
 *      /opt/hoop, so only root inside the container can reach it).
 *      This contains the hooks that emit events back
 *      to the sandbox, the skills the dashboard surfaces, etc. Without
 *      including it, a freshly-bootstrapped sandbox produces no hook events.
 *   2. Any other plugins the user installed into the sandbox profile via
 *      installed_plugins.json (claude-mem, code-graph backends, …). Installed
 *      via `/hoop:setup`, which runs `claude` inside the sandbox.
 *
 * Cached briefly so spawn isn't re-reading the file each turn.
 */
let _pluginDirsCache: { value: string[]; expiresAt: number } | null = null;
export function discoverInstalledPluginDirs(): string[] {
  const now = Date.now();
  if (_pluginDirsCache && _pluginDirsCache.expiresAt > now) {
    return _pluginDirsCache.value;
  }
  const dirs: string[] = [];

  // (1) The runtime plugin. Look up the canonical location via env (the
  // compose sets HOOP_PLUGIN_ROOT=/opt/hoop), with a fallback
  // to that same default so the sandbox stays usable even if the env got
  // dropped. The dir is a valid plugin install when it has a
  // .claude-plugin/plugin.json — guard against that.
  const runtime = process.env.HOOP_PLUGIN_ROOT || "/opt/hoop";
  if (existsSync(join(runtime, ".claude-plugin", "plugin.json"))) {
    dirs.push(runtime);
  }

  // (2) Any user-installed plugins in the sandbox profile.
  const installed = join(homedir(), ".claude", "plugins", "installed_plugins.json");
  if (existsSync(installed)) {
    try {
      const body = JSON.parse(readFileSync(installed, "utf-8")) as {
        plugins?: Record<string, Array<{ installPath?: string }>>;
      };
      for (const entries of Object.values(body.plugins ?? {})) {
        const head = entries?.[0];
        if (head?.installPath && existsSync(head.installPath) && !dirs.includes(head.installPath)) {
          dirs.push(head.installPath);
        }
      }
    } catch {
      // ignore — fall back to runtime-only plugin loading
    }
  }
  _pluginDirsCache = { value: dirs, expiresAt: now + 10_000 };
  return dirs;
}
