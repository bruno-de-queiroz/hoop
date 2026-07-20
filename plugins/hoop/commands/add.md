---
description: Install an MCP server, a plugin, or a skill into the hoop sandbox. Wraps the real claude CLI inside the agent-sandbox container (claude mcp add / claude plugin install) or copies a skill directory into the sandbox profile.
allowed-tools: ["Bash"]
---

# /hoop:add

Adds a component to the **hoop sandbox** (not your host claude). The sandbox is
the containerized daily-driver profile at `~/.claude/hoop/sandbox/profile`; this
command writes there so the change shows up in dashboard sessions and in
`hoop open`.

It delegates to the `hoop` CLI, which forwards your arguments verbatim to the
real `claude` CLI running inside the `agent-sandbox` container (so anything
`claude mcp add` / `claude plugin install` accepts works), or copies a skill
directory into the sandbox profile.

---

## Targets

| Invocation | Effect |
|---|---|
| `/hoop:add mcp <name> [flags] [-- <command…>]` | `claude mcp add` inside the sandbox. Everything after `mcp` is passed straight through, including a `-- <command…>` for stdio servers (e.g. `-- npx -y some-mcp`). |
| `/hoop:add plugin [-m <marketplace>] <plugin[@marketplace]> …` | `claude plugin install` inside the sandbox. With `-m/--marketplace <spec>` it first runs `claude plugin marketplace add <spec>` (accepts `owner/repo` or a git URL). |
| `/hoop:add skill [-f] <path-to-skill-dir>` | Copies a local skill directory (must contain `SKILL.md`) into the sandbox profile so it appears at `~/.claude/skills/<name>`. `-f` overwrites an existing skill of the same name. |

`mcp` and `plugin` require the sandbox container to be running; the CLI prints a
hint (`hoop sandbox start`) if it isn't. `skill` works on the host and needs no
running container.

---

## Bash to run

```bash
"${CLAUDE_PLUGIN_ROOT}/cli/hoop.sh" sandbox add "$@"
```

Show the CLI's stdout/stderr verbatim — it narrates its own progress. After an
`mcp`/`plugin` install, remind the user that new MCPs load on the next session
(a `hoop sandbox restart` picks them up for already-running sessions).
