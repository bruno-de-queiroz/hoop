---
name: retrospective
description: Synthesize the session log into a learning artifact — what was tried, what worked, what alternatives were considered, and what each peer contributed.
---

# Hoop Retrospective

Use `/hoop:retrospective` after a productive session to extract the team's reasoning trail. The model reads the full session log and produces a structured narrative that captures *why* decisions were made, not just *what* changed.

## Steps

1. **Fetch the full log.** Call `hoop_session_log` with no arguments:

   ```json
   {}
   ```

   If the tool returns an error, display it and stop. If the entries array is empty, display:

   ```
   No session activity to retrospect on yet.
   ```

   Stop here.

2. **Synthesize.** Read every entry. Group session-note entries with the file-change entries that surround them in time — notes are often the *why* behind a *what*. Then produce a markdown report with these sections:

   ```markdown
   # Session retrospective

   ## What we set out to do
   <Inferred from the earliest notes + first few file-changes. 2–3 sentences.>

   ## What was tried
   <Bullet list. Each bullet pairs a note (the intent) with the file-changes that followed (the execution). Use the actual peer/author names from the entries.>

   ## What worked
   <Decisions that landed cleanly — file-changes with no follow-up reverts or notes second-guessing them.>

   ## Alternatives considered
   <Notes that explicitly weighed options or rejected approaches. Quote the note inline.>

   ## Per-peer contribution
   <One paragraph per peerId/author, summarizing what they drove.>

   ## Open threads
   <Any note phrased as a question, or any TODO-style note. List them as a checklist.>
   ```

3. **Be honest about gaps.** If a section has no supporting evidence in the log (e.g. no notes were taken), say so explicitly:

   ```
   ## Alternatives considered
   _No notes captured alternatives — encourage the team to use `/hoop:note` next time when weighing options._
   ```

   Don't fabricate reasoning that isn't in the log. The retrospective's value depends on its honesty.

## Notes

- Retrospective quality scales with note discipline. Sessions where peers used `/hoop:note` on key decisions produce richer artifacts.
- The session log resets on `/hoop:leave`. Run the retrospective before leaving if you want to keep it.
- This is a model-cost operation (the synthesis pass). For a raw chronological dump, use `/hoop:export`. For a peer-filtered slice, use `/hoop:replay`.
