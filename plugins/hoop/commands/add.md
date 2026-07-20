---
description: Install an MCP server, a plugin, or a skill into the hoop sandbox. Wraps the real claude CLI inside the agent-sandbox container (claude mcp add / claude plugin install) or copies a skill directory into the sandbox profile.
allowed-tools: ["Bash"]
---

# /hoop:add

Adds a component to the **hoop sandbox** (not your host claude). The sandbox
profile at `~/.claude/hoop/sandbox/profile` is bind-mounted into both the
dashboard's `agent-sandbox` container and every `hoop open` container, so a
component added here is **durable** (survives rebuild / restart / recreate) and
**shared** across dashboard sessions and `hoop open`.

It delegates to the `hoop` CLI, which forwards your arguments to the real
`claude` CLI running inside the `agent-sandbox` container (so anything
`claude mcp add` / `claude plugin install` accepts works), or copies a skill
directory into the sandbox profile.

---

## Targets

| Invocation | Effect |
|---|---|
| `/hoop:add mcp <name> [flags] [-- <command…>]` | `claude mcp add` inside the sandbox. **Defaults to `--scope user`** so the server is written to the top-level `mcpServers` in `~/.claude.json` — available in every session and in `hoop open`, not stranded under a single project. Everything is passed through, including a `-- <command…>` for stdio servers (e.g. `-- npx -y some-mcp`). Pass your own `-s/--scope` to override. |
| `/hoop:add plugin [-m <marketplace>] <plugin[@marketplace]> …` | `claude plugin install` inside the sandbox (installs at user scope). With `-m/--marketplace <spec>` it first runs `claude plugin marketplace add <spec>` (accepts `owner/repo` or a git URL). |
| `/hoop:add skill -d <path-to-skill-dir> [-f]` | Copies a local skill directory (must contain `SKILL.md`) into the sandbox profile so it appears at `~/.claude/skills/<name>`. Symlinks are dereferenced (`cp -RL`) so the real files land in the profile and resolve inside the container. `-f` overwrites an existing skill of the same name. |

`mcp` and `plugin` require the sandbox container to be running; the CLI prints a
hint (`hoop sandbox start`) if it isn't. `skill` works on the host and needs no
running container.

---

## Bash to run

Pass the subcommand and its arguments straight through, e.g.
`add mcp <name> -- <cmd>`, `add plugin -m <marketplace> <plugin>`, or
`add skill -d <abs-path-to-skill-dir>` (resolve the skill path to an absolute
directory first):

```bash
"${CLAUDE_PLUGIN_ROOT}/cli/hoop.sh" add "$@"
```

Show the CLI's stdout/stderr verbatim — it narrates its own progress. After an
`mcp`/`plugin` install, remind the user that new MCPs load on the next session
(a `hoop sandbox restart` picks them up for already-running sessions).
