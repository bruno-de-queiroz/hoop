---
name: replay
description: Replay a slice of the session log — optionally filtered to one peer and/or limited to the last N entries.
---

# Hoop Replay

Use `/hoop:replay [peerId] [N]` to render recent activity from the shared session log. Helpful when you've just joined, just `/compact`-ed, or want to see what a teammate has been doing.

## Steps

1. **Parse arguments.** The user invocation may include 0, 1, or 2 positional arguments:

   - `/hoop:replay`            — full log (capped server-side)
   - `/hoop:replay <peerId>`   — entries from that peer only
   - `/hoop:replay <peerId> 20` — last 20 entries from that peer
   - `/hoop:replay 20`         — last 20 entries across all peers (numeric-only first arg = limit)

2. **Fetch the log.** Call `hoop_session_log` with the parsed args:

   ```json
   { "peerId": "<peerId or omit>", "limit": <N or omit> }
   ```

   If the tool returns an error, display it and stop.

3. **Render.** The response is `{ entries: SessionLogEntry[] }`. Each entry has `{ ts, type, peerId, payload }`.

   If empty, display:

   ```
   (no entries in session log yet)
   ```

   Otherwise render one line per entry, formatted by type:

   - `session-note`   → `<HH:MM:SS> <author|peerId>  📝 <text>`
   - `file-change`    → `<HH:MM:SS> <peerId>  ✏️  <filePath>`
   - `lock-acquire`   → `<HH:MM:SS> <peerId>  🔒 acquired`
   - `lock-release`   → `<HH:MM:SS> <peerId>  🔓 released`
   - `cursor-update`  → `<HH:MM:SS> <peerId>  📍 <filePath>:<line>`
   - `buffer-update`  → `<HH:MM:SS> <peerId>  📄 <filePath> (dirty=<dirty>)`
   - `metadata-update` → `<HH:MM:SS> <peerId>  ⚙️ <key>=<value>`

   Format the timestamp from `ts` (epoch ms) as local `HH:MM:SS`.

## Notes

- The log is in-memory + on-disk for the current session; it resets on `/hoop:leave`.
- For exporting to markdown, use `/hoop:export` instead.
- For a synthesis (what was tried, what worked), use `/hoop:retrospective`.
