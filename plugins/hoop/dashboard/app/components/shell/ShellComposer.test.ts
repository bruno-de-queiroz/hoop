import { describe, it, expect } from "vitest";
import { classifyComposerInput } from "./ShellComposer";

// The composer routes a composed line to one of five destinations. The two
// control commands (`/stop`, `/model <alias>`) are the important regression:
// they must be intercepted client-side and NEVER fall through to `send` (which
// would forward them to the model as plain text — they'd never stop/switch).
describe("classifyComposerInput", () => {
  it("routes plain text to the model", () => {
    expect(classifyComposerInput("hello there", false)).toEqual({ kind: "send", text: "hello there" });
  });

  it("routes `!cmd` to bash (text-only)", () => {
    expect(classifyComposerInput("!ls -la", false)).toEqual({ kind: "bash", command: "ls -la" });
    // An attachment forces the send path — bash can't carry images.
    expect(classifyComposerInput("!ls", true)).toEqual({ kind: "send", text: "!ls" });
  });

  it("routes `>msg` to participant chat (with or without images)", () => {
    expect(classifyComposerInput(">psst", false)).toEqual({ kind: "chat", text: "psst" });
    expect(classifyComposerInput(">psst", true)).toEqual({ kind: "chat", text: "psst" });
  });

  it("intercepts /stop as a control command, not a message", () => {
    expect(classifyComposerInput("/stop", false)).toEqual({ kind: "stop" });
  });

  it("intercepts /model <alias> and trims the alias", () => {
    expect(classifyComposerInput("/model opus", false)).toEqual({ kind: "model", model: "opus" });
    expect(classifyComposerInput("/model   sonnet-4  ", false)).toEqual({ kind: "model", model: "sonnet-4" });
  });

  it("does not intercept a bare /model (no alias) — falls through to the model", () => {
    expect(classifyComposerInput("/model", false)).toEqual({ kind: "send", text: "/model" });
  });

  it("does not treat /stop or /model as control commands when an image is attached", () => {
    expect(classifyComposerInput("/stop", true)).toEqual({ kind: "send", text: "/stop" });
    expect(classifyComposerInput("/model opus", true)).toEqual({ kind: "send", text: "/model opus" });
  });

  it("leaves other slash commands (e.g. /plan, /cost) as normal sends to the model", () => {
    expect(classifyComposerInput("/plan add caching", false)).toEqual({ kind: "send", text: "/plan add caching" });
    expect(classifyComposerInput("/cost", false)).toEqual({ kind: "send", text: "/cost" });
    // A message that merely mentions /stop mid-line is not the command.
    expect(classifyComposerInput("please /stop the loop", false)).toEqual({
      kind: "send",
      text: "please /stop the loop",
    });
  });
});
