import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readSkill(...parts: string[]) {
  return readFileSync(join(process.cwd(), ...parts), "utf-8");
}

describe("skill definitions", () => {
  it("/hoop-new uses the MCP create-session tool and preserves the prompt/output UX", () => {
    const content = readSkill("skills", "hoop-new", "SKILL.md");

    expect(content).toContain("hoop_create_session");
    expect(content).not.toContain("import { createSession }");
    expect(content).not.toContain("src/session/createSession");
    expect(content).toContain("Select execution target:");
    expect(content).toContain("UserPromptSubmit");
    expect(content).toContain("admit or deny");
    expect(content).toContain("Session created!");
    expect(content).toContain("Share this code with peers");
  });

  it("/hoop-join uses the MCP join-session tool and preserves the prompt/output UX", () => {
    const content = readSkill("skills", "hoop-join", "SKILL.md");

    expect(content).toContain("hoop_join_session");
    expect(content).not.toContain("import { joinSession }");
    expect(content).not.toContain("src/session/joinSession");
    expect(content).toContain("Enter the host's listen address (multiaddr):");
    expect(content).toContain("Enter your email (for host admission):");
    expect(content).toContain("Connected to session!");
  });

  it("/hoop-agent uses MCP status/lock tools and Agent for sub-agent spawning", () => {
    const content = readSkill("skills", "hoop-agent", "SKILL.md");

    // Uses MCP tools, not internal TypeScript
    expect(content).toContain("hoop_get_status");
    expect(content).toContain("hoop_acquire_lock");
    expect(content).toContain("hoop_release_lock");
    expect(content).toContain("`Agent` tool");
    expect(content).not.toContain("import {");
    expect(content).not.toContain("src/session/");
    expect(content).not.toContain("src/mcp/");

    // Model parsing via --model flag
    expect(content).toContain("--model");
    expect(content).toContain("opus");
    expect(content).toContain("sonnet");
    expect(content).toContain("haiku");

    // Agent tool parameters
    expect(content).toContain("`description`:");
    expect(content).toContain("`model`:");
    expect(content).toContain("`prompt`:");

    // UX strings — happy path and error paths
    expect(content).toContain("Usage: /hoop-agent");
    expect(content).toContain("No active Hoop session");
    expect(content).toContain("Cannot start agent");
    expect(content).toContain("Agent completed. Lock released.");
  });
});
