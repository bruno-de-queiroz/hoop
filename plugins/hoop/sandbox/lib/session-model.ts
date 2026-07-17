import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const TAIL_BYTES = 64 * 1024;

const modelCache = new Map<string, { mtimeMs: number; model: string | null }>();

export function getSessionModel(sessionId: string): { model: string | null } {
  const file = findTranscript(sessionId);
  if (!file) return { model: null };

  let mtimeMs = 0;
  try { mtimeMs = statSync(file).mtimeMs; } catch { /* ignore */ }
  const cached = modelCache.get(sessionId);
  if (cached && cached.mtimeMs === mtimeMs) {
    return { model: cached.model };
  }

  const tail = readTail(file, TAIL_BYTES);
  // Claude emits assistant frames with model: "<synthetic>" for built-in
  // slash commands (/cost, /clear, /compact) and other internal events.
  // Those frames get persisted to the transcript jsonl. If we naively
  // returned the LAST model field we'd surface "<synthetic>" any time a
  // synthetic frame was the most recent — which is the case on every
  // session wake (claude-mem's observer hook emits one). Walk matches
  // from newest to oldest and return the first NON-synthetic value.
  const matches = tail.match(/"model"\s*:\s*"([^"]+)"/g) ?? [];
  let model: string | null = null;
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i].match(/"model"\s*:\s*"([^"]+)"/)?.[1];
    if (!m || m === "<synthetic>") continue;
    model = m;
    break;
  }

  modelCache.set(sessionId, { mtimeMs, model });
  return { model };
}

// sessionId -> transcript path. The transcript lives in a fixed project dir for
// the life of a session, so once found the path is stable — cache it to avoid a
// readdirSync(PROJECTS_DIR) + existsSync-per-dir scan on every call (this ran
// even on a modelCache hit). Re-scan only on a miss or if the cached path has
// since vanished.
const transcriptPathCache = new Map<string, string>();

function findTranscript(sessionId: string): string | null {
  const cached = transcriptPathCache.get(sessionId);
  if (cached && existsSync(cached)) return cached;
  if (!existsSync(PROJECTS_DIR)) return null;
  try {
    for (const proj of readdirSync(PROJECTS_DIR)) {
      const candidate = join(PROJECTS_DIR, proj, `${sessionId}.jsonl`);
      if (existsSync(candidate)) {
        transcriptPathCache.set(sessionId, candidate);
        return candidate;
      }
    }
  } catch { /* ignore */ }
  return null;
}

function readTail(path: string, maxBytes: number): string {
  const stat = statSync(path);
  const start = stat.size > maxBytes ? stat.size - maxBytes : 0;
  const len = stat.size - start;
  if (len <= 0) return "";
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return buf.toString("utf-8");
  } finally {
    closeSync(fd);
  }
}
