---
description: Bind-mount a host folder into the hoop sandbox workspace so dashboard sessions and hoop open can read/write it. Recreates the agent-sandbox container to apply the mount.
allowed-tools: ["Bash"]
---

# /hoop:mount

Bind-mounts a folder from your host into the sandbox at
`/home/agent/workspace/<name>`, so agent sessions (and `hoop open`) can work on
it. By default the dashboard sandbox only mounts the claude profile — your code
lives on the host, so mounting is how you expose a project to it.

Mounts persist across restarts (they are stored in `mounts.list` and layered
onto the compose config via a generated override). Applying or removing a mount
**recreates the agent-sandbox container**, which briefly interrupts running
sandbox sessions.

---

## Usage

| Invocation | Effect |
|---|---|
| `/hoop:mount add -p <host-path> [-n <name>]` | Mount `<host-path>` at `/home/agent/workspace/<name>` (`-n` defaults to the folder's basename), then recreate the sandbox. |
| `/hoop:mount list` | List the currently configured mounts. |
| `/hoop:mount remove <name>` | Remove the mount with that name, then recreate the sandbox. |

The mount target lands under the workspace, which is already an allowed cwd for
sessions. Resolve `<host-path>` to an absolute directory before mounting.

---

## Bash to run

Pass the subcommand and its arguments straight through — `add -p <abs-path>
[-n <name>]`, `list`, or `remove <name>`:

```bash
"${CLAUDE_PLUGIN_ROOT}/cli/hoop.sh" mount "$@"
```

Show the CLI's stdout/stderr verbatim. Warn the user that `add`/`remove`
recreate the agent-sandbox container.
