# Catalog: platform MCPs (org-configurable)

Read by `/hoop:setup`. Multi-select category. Defaults all selected. Each tool is installed independently; failures stop the wizard with a fixable error message.

Tools:
- Atlassian (Jira + Confluence)
- Google Workspace CLI (`gws`)
- GitHub CLI (`gh`)
- incident.io
- Slack

---

## Option: Atlassian (Jira + Confluence)

**One-line pitch:** Built-in Atlassian remote MCP. Lets Claude search Jira and read Confluence directly.

**Install:** Atlassian is a built-in remote MCP server in modern Claude Code; no `claude mcp add` required. The wizard prints the connect flow:

```
/mcp                       # in Claude Code
# Find Atlassian in the list, click Connect.
# Browser opens; sign in with your org's Atlassian account.
# Click Allow.
```

This is a slash-command + browser interaction step. Setup prints the instructions and waits for the user to confirm "done".

**Verify:**
Ask Claude: `Find my open Jira tickets`. A non-empty list means it's connected.

**Troubleshooting:**
- Not visible in `/mcp`: upgrade Claude Code (`brew upgrade claude-code` or `npm update -g @anthropic-ai/claude-code`).
- Login fails: use your org email.
- No tickets: you may not be added to the right Jira projects yet.

---

## Option: Google Workspace CLI (`gws`)

**One-line pitch:** Email, calendar, Drive, Docs via the `gws` CLI from https://github.com/googleworkspace/cli. Requires a SOCKS5h proxy wrapper (proxychains-ng) to work inside Claude Code's sandbox.

**Install (auto-runnable, package-manager-agnostic):**

The wizard picks the first available install method:

| Method | Command | Notes |
|---|---|---|
| npm (preferred; cross-platform, bundles native binary) | `npm install -g @googleworkspace/cli` | Works on macOS, Linux, Windows. Requires Node.js (already in the container Dockerfile). |
| Homebrew (macOS / Linuxbrew) | `brew install googleworkspace-cli` | Convenient on macOS hosts. |
| Direct binary release | `curl -L https://github.com/googleworkspace/cli/releases/latest/download/gws-$(uname -s)-$(uname -m).tar.gz \| tar -xz -C /usr/local/bin gws` | No package manager needed; uses GitHub releases. |
| Cargo from source | `cargo install --git https://github.com/googleworkspace/cli --locked` | If you have a Rust toolchain. |

Default order in the wizard: npm → brew → direct binary.

**Install (proxychains-ng):**

| Platform | Command |
|---|---|
| macOS / Linuxbrew | `brew install proxychains-ng` |
| Debian / Ubuntu | `sudo apt-get install -y proxychains4` |
| RHEL / Fedora | `sudo dnf install -y proxychains-ng` |
| Alpine | `apk add proxychains-ng` |

Container default (Debian-slim) is `proxychains4` via apt; the Dockerfile already installs it.

**Configure OAuth client:** The wizard prompts the user for `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`. If your org already provisions these, retrieve them from your org's password manager (1Password, Dashlane, Vault, etc.). Otherwise supply your own OAuth client (Desktop app type) created at https://console.cloud.google.com/apis/credentials, with the relevant Google Workspace APIs enabled at https://console.cloud.google.com/apis/library.

The user pastes the values; setup exports them:

```bash
export GOOGLE_WORKSPACE_CLI_CLIENT_ID="$ID"
export GOOGLE_WORKSPACE_CLI_CLIENT_SECRET="$SECRET"
```

**Authenticate (interactive):**
```bash
gws auth login
```

The user selects all 9 scopes in the terminal screen, opens the URL in their browser, signs in with the Google account they want Claude to act as, clicks Allow. Setup waits for the user to confirm "done".

**Export credentials for sandbox use:**
```bash
mkdir -p ~/.config/gws
gws auth export --unmasked > ~/.config/gws/gws-credentials.json
chmod 600 ~/.config/gws/gws-credentials.json
```

**Sandbox-wrapper note:** the original gws docs assume Claude Code's native sandbox (DNS-blocked, SOCKS5h-proxied). The hoop sandbox container has direct egress, so the `~/.local/bin/gws` wrapper below is **not** needed there — bare `gws` works once `client_secret.json` + `credentials.json` are mounted at `~/.config/gws/`. The wrapper is still useful when gws runs inside Claude Code's own sandbox (e.g. for a host-side install that needs to remain wrapped). Skip this block for an hoop-only setup.

**Create sandbox wrapper (optional, only when DNS-blocked):** Write `~/.local/bin/gws` to route gws through Claude Code's SOCKS5h proxy via proxychains-ng. Required because gws resolves DNS locally and the sandbox blocks direct DNS. The wrapper resolves the real `gws` and `proxychains4` binaries at runtime via `command -v` (no hardcoded `/opt/homebrew/bin` paths). Setup writes it via `cat > ~/.local/bin/gws << 'WRAPPER' ... WRAPPER && chmod +x ~/.local/bin/gws`:

```bash
#!/bin/bash
# Resolve real binaries (skip our own wrapper).
GWS_BIN=$(PATH=$(echo "$PATH" | tr ':' '\n' | grep -v "$HOME/.local/bin" | tr '\n' ':') command -v gws 2>/dev/null)
PROXYCHAINS_BIN=$(command -v proxychains4 2>/dev/null)
if [ -z "$GWS_BIN" ]; then
  echo "gws not found in PATH outside ~/.local/bin. Install via npm/brew/binary first." >&2
  exit 127
fi
if [ -n "$ALL_PROXY" ] && [ -x "$PROXYCHAINS_BIN" ]; then
  PROXY_PORT=$(echo "$ALL_PROXY" | sed 's|socks5h://[^:]*:||')
  CONF="${TMPDIR:-/tmp}/proxychains-gws-$$.conf"
  printf "strict_chain\nproxy_dns\n[ProxyList]\nsocks5 127.0.0.1 %s\n" "$PROXY_PORT" > "$CONF"
  "$PROXYCHAINS_BIN" -q -f "$CONF" "$GWS_BIN" "$@"
  STATUS=$?
  rm -f "$CONF"
  exit $STATUS
else
  exec "$GWS_BIN" "$@"
fi
```

**Verify:**
```bash
which gws                    # expect: ~/.local/bin/gws
gws auth status              # expect: token_valid: true
gws calendar events list --params '{"calendarId": "primary", "maxResults": 3}'
```

**Important:** Claude Code may also surface a "Google Workspace MCP" server. **Do not connect it.** Always use the `gws` CLI wrapper. The permissions step writes a `CLAUDE.local.md` instruction enforcing this.

---

## Option: GitHub CLI (`gh`)

**One-line pitch:** Repos, PRs, issues, CI status via the GitHub CLI authenticated to the user's GitHub account / org.

**Prereqs:** Homebrew.

**Install (auto-runnable):**
```bash
brew install gh
```

**Authenticate (interactive):**
```bash
gh auth login
```

Choose: GitHub.com → HTTPS → Login with a web browser. Setup tells the user a browser will open; they sign in with their GitHub account. If they have multiple GitHub accounts:

```bash
gh auth switch --user YOUR_USERNAME
```

**Verify org access (user-supplied org):**
```bash
gh repo list <your-org> --limit 5
```

The wizard prompts for the GitHub org name to verify against. If the verify command returns "Could not resolve to an Organization" or empty, the GitHub account isn't in that org. Setup tells the user to ask their org owner for an invite.

---

## Option: incident.io

**One-line pitch:** Query incidents, alerts, and on-call data from Claude.

**Install (auto-runnable):**
```bash
claude mcp add --scope user incident-io --transport http https://mcp.incident.io/mcp
```

**Authenticate (deferred, browser OAuth on first tool use):** OAuth doesn't fire at registration. Setup tells the user to restart Claude Code, then ask something like "list my recent incidents"; a browser will open. Sign in with your org account.

**Verify:**
```bash
/mcp                # in Claude Code; expect to see incident-io listed
```

---

## Option: Slack

**One-line pitch:** Claude reads channels, threads, and DMs; can post messages. Official Slack MCP.

**Install (built-in remote MCP):** Slack is exposed via the built-in Claude Code MCP connector list. The wizard tells the user:

```
/mcp                          # in Claude Code
# Find Slack in the list, click Connect.
# Browser opens; sign in to Slack and authorize your workspace.
```

Setup prints the instructions and waits for "done".

**Alternative (manual MCP add):**
```bash
claude mcp add --scope user --transport http slack https://slack.com/mcp
```

The hosted endpoint handles OAuth on first use.

**Verify:** Ask Claude `What's the latest in <a channel you're in>?` and confirm it can read.
