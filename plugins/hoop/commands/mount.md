---
description: Bind-mount a host folder into the hoop sandbox workspace so dashboard sessions and hoop open can read/write it. Recreates the agent-sandbox container to apply the mount.
allowed-tools: ["Bash"]
---

# /hoop:mount

Bind-mounts a folder from your host into the sandbox at
`/home/agent/workspace/<name>`, so agent sessions (and `hoop open`) can work on
it. By default the dashboard sandbox only mounts the claude profile — your code
lives on the host, so mounting is how you expose a project to it.

Mounts persist across restarts (they are stored and layered onto the compose
config via a generated override). Applying a mount **recreates the
agent-sandbox container**, which briefly interrupts running sandbox sessions.

---

## Usage

| Invocation | Effect |
|---|---|
| `/hoop:mount <host-path> [name]` | Mount `<host-path>` at `/home/agent/workspace/<name>` (name defaults to the folder's basename), then recreate the sandbox. |
| `/hoop:mount` (via `hoop sandbox mounts`) | Use `hoop sandbox mounts` to list current mounts and `hoop sandbox unmount <name>` to remove one. |

The mount target lands under the workspace, which is already an allowed cwd for
sessions — start a session and use `/hoop:add` or the workspace path as needed.

---

## Bash to run

```bash
"${CLAUDE_PLUGIN_ROOT}/cli/hoop.sh" sandbox mount "$@"
```

Show the CLI's stdout/stderr verbatim. Warn the user that this recreates the
agent-sandbox container. To manage existing mounts, run
`hoop sandbox mounts` / `hoop sandbox unmount <name>`.
