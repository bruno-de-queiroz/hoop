"use client";
import { useEffect, useRef } from "react";

// Live event channel. Despite the name, the transport is a WebSocket (`/api/ws`),
// not Server-Sent Events: SSE is buffered to death by Cloudflare quick tunnels
// (the whole `text/event-stream` response is held and never flushed), so a
// remote co-driving peer never received live events. WebSockets are an upgrade
// protocol, not a buffered HTTP response, and pass through CF tunnels live.
//
// The public API is unchanged — `useSSE({ <type>: handler })` — so every
// consumer (transcript, presence, selection, …) is untouched. The server sends
// `{ type, data }` JSON frames; we dispatch `data` to the handlers registered
// for that `type`.

type Handler = (data: unknown) => void;
type Handlers = Record<string, Handler>;

let socket: WebSocket | null = null;
const handlersByType = new Map<string, Set<Handler>>();
let refCount = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoff = 250;
let closedByUs = false;

function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/ws`;
}

function dispatch(type: string, data: unknown) {
  const set = handlersByType.get(type);
  if (!set || set.size === 0) return;
  for (const h of set) {
    try { h(data); } catch { /* a bad handler must not kill the socket */ }
  }
}

function connect() {
  if (socket || closedByUs) return;
  let ws: WebSocket;
  try { ws = new WebSocket(wsUrl()); } catch { scheduleReconnect(); return; }
  socket = ws;

  ws.onopen = () => { backoff = 250; };
  ws.onmessage = (e) => {
    let frame: { type?: string; data?: unknown };
    try { frame = JSON.parse(typeof e.data === "string" ? e.data : ""); } catch { return; }
    if (frame && typeof frame.type === "string") dispatch(frame.type, frame.data);
  };
  ws.onclose = (e) => {
    if (socket === ws) socket = null;
    // 4403 = the server cut this peer's feed because their share was revoked.
    // Stop reconnecting (a revoked link can't re-open the channel) and tell the
    // UI so it can take over with an "access ended" state.
    if (e.code === 4403) {
      closedByUs = true;
      dispatch("revoked", { reason: "share revoked" });
      return;
    }
    scheduleReconnect();
  };
  ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
}

function scheduleReconnect() {
  if (closedByUs || refCount <= 0 || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, backoff);
  backoff = Math.min(backoff * 2, 5000);
}

function teardown() {
  closedByUs = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  const s = socket;
  socket = null;
  if (s) { try { s.close(); } catch { /* ignore */ } }
  handlersByType.clear();
}

function subscribe(type: string, h: Handler) {
  let set = handlersByType.get(type);
  if (!set) { set = new Set(); handlersByType.set(type, set); }
  set.add(h);
}

function unsubscribe(type: string, h: Handler) {
  const set = handlersByType.get(type);
  if (!set) return;
  set.delete(h);
  if (set.size === 0) handlersByType.delete(type);
}

/**
 * Shared live-channel hook. Multiple components mount/unmount independently but
 * share one WebSocket; it reconnects with backoff and closes when the last
 * subscriber unmounts.
 */
export function useSSE(handlers: Handlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    closedByUs = false;
    refCount += 1;
    connect();

    const bound: Array<[string, Handler]> = [];
    for (const type of Object.keys(handlersRef.current)) {
      const h: Handler = (data) => handlersRef.current[type]?.(data);
      subscribe(type, h);
      bound.push([type, h]);
    }

    return () => {
      for (const [t, h] of bound) unsubscribe(t, h);
      refCount -= 1;
      if (refCount <= 0) {
        refCount = 0;
        teardown();
      }
    };
  }, []);
}
