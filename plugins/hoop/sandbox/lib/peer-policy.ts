/**
 * Command policy for PEER co-drivers (not the local host). A peer is someone
 * invited via a share link; pairing is semi-trusted, so this is a guardrail
 * against accidental/casual exfiltration and unwanted pushes — NOT a hard
 * boundary against a determined hostile party (a shell denylist can always be
 * obfuscated; the real boundary is "don't share with someone you don't trust").
 *
 * Enforced authoritatively sandbox-side on the `!bash` fast lane (which bypasses
 * the model + permission gate) and, for git push, also on permission approvals.
 */

/** git push / force-push in any form: `git push`, `git -C dir push`, `git push --force`. */
export function isGitPush(command: string): boolean {
  // Match a `git` invocation that also contains a `push` subcommand/word.
  // Deliberately broad (errs toward catching) — a false positive just routes a
  // command to host approval rather than silently running it.
  return /\bgit\b[^\n;|&]*\bpush\b/i.test(command);
}

// Paths whose contents are secrets/tokens the host doesn't want a peer reading.
// Mirrors the philosophy of the user's settings.json deny-list, extended for
// the direct-exec lane.
const SECRET_PATTERNS: RegExp[] = [
  /\.credentials\.json/i,
  /\.claude\.json/i,
  /\/var\/run\/hoop/i,    // sandbox + hook tokens, socket
  /hook\.token/i,
  /\bid_rsa\b|\bid_ed25519\b|\bid_ecdsa\b/i,
  /(^|[\s\/'"~])\.ssh(\/|\b)/i, // ~/.ssh, .ssh/, /home/agent/.ssh
  /(^|[\s\/'"~])\.aws(\/|\b)/i,
  /(^|[\s\/'"~])\.env(\.|\b)/i,
];

// Bare environment dumps leak any token that lives in the process env.
// Allows `env VAR=x cmd` (env with assignment args), blocks `env`, `env|...`,
// `env > f`, and `printenv`.
const ENV_DUMP_PATTERNS: RegExp[] = [
  /(^|[;&|]\s*)printenv\b/i,
  /(^|[;&|]\s*)env\s*($|[|>])/i,
];

export interface PolicyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Whether a peer may run this `!bash` command directly. Host commands are never
 * checked (the host already has full shell + the dashboard token).
 */
export function peerBashAllowed(command: string): PolicyResult {
  if (isGitPush(command)) {
    return { ok: false, reason: "git push is host-only in a shared session" };
  }
  for (const re of SECRET_PATTERNS) {
    if (re.test(command)) {
      return { ok: false, reason: "command would read host secrets/tokens (blocked for guests)" };
    }
  }
  for (const re of ENV_DUMP_PATTERNS) {
    if (re.test(command)) {
      return { ok: false, reason: "environment dumps are blocked for guests (may contain tokens)" };
    }
  }
  return { ok: true };
}
