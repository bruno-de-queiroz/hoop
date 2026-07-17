import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import PlanPanel from "./PlanPanel";

// usePlanComments polls the shared store; stub fetch so it's an inert no-op
// (returns no comments) and the tests focus on the panel's own behavior.
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ comments: [], you: "host" }) })));
});

function setup(overrides: Partial<React.ComponentProps<typeof PlanPanel>> = {}) {
  const onApprove = vi.fn(async () => {});
  const onReject = vi.fn(async () => {});
  const onClose = vi.fn();
  render(
    <PlanPanel
      sessionId="s1"
      requestId="r1"
      plan={"# Plan\n\nStep one does the thing."}
      sessionLabel="weather-skill"
      onApprove={onApprove}
      onReject={onReject}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onApprove, onReject, onClose };
}

describe("PlanPanel", () => {
  it("renders the plan markdown and session label", () => {
    setup();
    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.getByText(/Step one does the thing/)).toBeInTheDocument();
    expect(screen.getByText("weather-skill")).toBeInTheDocument();
  });

  it("Approve calls onApprove", async () => {
    const { onApprove } = setup();
    await act(async () => {
      fireEvent.click(screen.getByText("Approve"));
    });
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("Request changes is disabled until there is feedback, then posts the note", async () => {
    const { onReject } = setup();
    const btn = screen.getByText("Request changes") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);

    const note = screen.getByPlaceholderText(/add an overall note/i);
    await act(async () => {
      fireEvent.change(note, { target: { value: "Tighten step one." } });
    });
    expect((screen.getByText("Request changes") as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByText("Request changes"));
    });
    expect(onReject).toHaveBeenCalledWith("Tighten step one.");
  });

  it("surfaces an error message", () => {
    setup({ error: "HTTP 500" });
    expect(screen.getByText("HTTP 500")).toBeInTheDocument();
  });

  it("hides the decision controls when the viewer can't decide (drive peer)", () => {
    setup({ canDecide: false });
    expect(screen.queryByText("Approve")).not.toBeInTheDocument();
    expect(screen.queryByText("Request changes")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/add an overall note/i)).not.toBeInTheDocument();
    // …but the plan is still shown so the peer can read and comment on it.
    expect(screen.getByText(/Step one does the thing/)).toBeInTheDocument();
    expect(screen.getByText(/host approves or rejects/i)).toBeInTheDocument();
  });

  it("close button calls onClose", async () => {
    const { onClose } = setup();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Close"));
    });
    expect(onClose).toHaveBeenCalled();
  });
});
