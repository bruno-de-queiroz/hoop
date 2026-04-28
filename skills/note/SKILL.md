---
name: note
description: Capture a free-form session note (a decision, alternative considered, or reasoning step) and broadcast it to all peers. Notes are appended to the session log for export and retrospective.
---

# Hoop Note

Use `/hoop:note <text>` to record a thinking step that should survive `/compact` and reach other peers as part of the shared session memory.

## Steps

1. **Validate.** If the user passed no text, display:

   ```
   Usage: /hoop:note <text>
     Example: /hoop:note "trying the map() approach instead of the for-loop"
   ```

   Stop here.

2. **Send the note.** Call the `hoop_add_note` MCP tool with the user's text exactly as written:

   ```json
   { "text": "<the user's note text, verbatim>" }
   ```

   The schema accepts only `text`. Author identity is anchored to the broadcasting peerId server-side; do not invent or pass other fields.

   If the tool returns an error (e.g. "No active session.", "Note rate limit exceeded: ...", "Failed to add note: ..."), display the error and stop.

3. **Confirm.** On success, the response includes `accepted: true`. Display:

   ```
   📝 Note broadcast to peers — added to session log.
   ```

## Notes

- Notes are broadcast through the same pipeline as file changes and lock events, with at-least-once delivery and replay-on-reconnect.
- Peers will see the note injected into their next prompt's context (via the `UserPromptSubmit` hook drain) without having to call any tool.
- Notes accumulate in the session log and surface in `/hoop:export` and `/hoop:retrospective`.
