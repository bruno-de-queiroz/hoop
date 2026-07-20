import { presenceBus } from "@/lib/presence";
import { client } from "@/lib/sandbox-client";

/**
 * Bridges the dashboard-local presence layer to the sandbox's durable event
 * log: when presence decides a peer has genuinely left (grace-confirmed beacon
 * leave, or a silent-drop watchdog), it emits a `left` signal on the presence
 * bus; this turns that into a `PeerLeft` transcript marker via the sandbox.
 *
 * Registered ONCE on the process-wide presence bus (guarded on globalThis, the
 * same way the presence registry itself is — Next standalone can load a module
 * in more than one graph, and the bus is the singleton they share). Kept out of
 * presence.ts on purpose so that pure UI-awareness module never imports the
 * sandbox client; the SSE stream's per-connection presence listener can't do
 * this job (it would fire N times, or zero).
 */
export function initPresenceLeaveBridge(): void {
  const g = globalThis as unknown as { __hoop_presence_leave_bridge__?: boolean };
  if (g.__hoop_presence_leave_bridge__) return;
  g.__hoop_presence_leave_bridge__ = true;

  presenceBus().on("left", (payload: unknown) => {
    const p = payload as { sessionId?: string; name?: string | null };
    if (!p?.sessionId) return;
    // Fire-and-forget: the marker is best-effort audit, never load-bearing, so a
    // transient sandbox blip must not throw into the presence bus's emit.
    void client.peerLeave(p.sessionId, p.name ?? null).catch(() => { /* non-fatal */ });
  });
}
