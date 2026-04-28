---
name: export
description: Export the full session log as a markdown document — file changes, lock events, notes, and governance changes in chronological order.
---

# Hoop Export

Use `/hoop:export` to produce a markdown record of the current session. Useful for paste-into-PR, attaching to an issue, or saving the team's reasoning trail at end-of-session.

## Steps

1. **Fetch the log.** Call `hoop_session_log` with no arguments:

   ```json
   {}
   ```

   If the tool returns an error, display it and stop.

2. **Render markdown.** The response is `{ entries: SessionLogEntry[] }`. Format as:

   ```markdown
   # Hoop session log — <local-date-time>

   ## Timeline

   - **HH:MM:SS** `peerId`  — <type-specific line>
   - …

   ## Notes (📝)

   <each session-note rendered as a blockquote with author and timestamp>

   ## File changes (✏️)

   <each file-change as filePath + first 8 chars of resultHash + a fenced diff if patch is small>

   ## Lock activity (🔒)

   <each lock-acquire / lock-release on a single line>
   ```

   Type-specific timeline lines:

   - `session-note`   → `📝 <author|peerId>: <text>`
   - `file-change`    → `✏️ <filePath>`
   - `lock-acquire`   → `🔒 acquired`
   - `lock-release`   → `🔓 released`
   - `metadata-update` → `⚙️ <key> updated`
   - other types       → omit from the timeline

3. **Display the markdown inline.** Wrap in a fenced ```markdown block so the user can copy-paste cleanly.

## Notes

- The log is capped at 5000 entries; very long sessions get the most-recent slice.
- The session log resets on `/hoop:leave`. Export before leaving if you want to keep the record.
- For a synthesized narrative ("what was tried, what worked, what alternatives") use `/hoop:retrospective`.
