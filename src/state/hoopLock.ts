import type { LockAcquireUpdate, LockReleaseUpdate } from "./stateUpdate.js";

export interface HoopLock {
  holderPeerId: string | null;
  acquiredAt: number | null;
  status: "free" | "busy";
}

export type HoopLockUpdate = LockAcquireUpdate | LockReleaseUpdate;

export const HOOP_LOCK_TTL_MS = 5 * 60_000;

export function createFreeHoopLock(): HoopLock {
  return {
    holderPeerId: null,
    acquiredAt: null,
    status: "free",
  };
}

export function createBusyHoopLock(holderPeerId: string, acquiredAt: number): HoopLock {
  return {
    holderPeerId,
    acquiredAt,
    status: "busy",
  };
}

export function isHoopLockExpired(lock: HoopLock, now: number = Date.now()): boolean {
  return (
    lock.status === "busy" &&
    lock.acquiredAt !== null &&
    now - lock.acquiredAt >= HOOP_LOCK_TTL_MS
  );
}

export function normalizeHoopLock(lock: HoopLock, now: number = Date.now()): HoopLock {
  return isHoopLockExpired(lock, now) ? createFreeHoopLock() : { ...lock };
}

export function applyHoopLockUpdate(lock: HoopLock, update: HoopLockUpdate): HoopLock {
  const current = normalizeHoopLock(lock, update.timestamp);

  if (update.type === "lock-acquire") {
    if (current.status === "busy" && current.holderPeerId !== update.peerId) {
      return current;
    }
    return createBusyHoopLock(update.peerId, update.timestamp);
  }

  if (current.status !== "busy" || current.holderPeerId !== update.peerId) {
    return current;
  }

  return createFreeHoopLock();
}

export function expireHoopLock(
  lock: HoopLock,
  timestamp: number = Date.now(),
): { lock: HoopLock; releaseUpdate?: LockReleaseUpdate } {
  if (lock.status !== "busy" || lock.holderPeerId === null || !isHoopLockExpired(lock, timestamp)) {
    return { lock: { ...lock } };
  }

  return {
    lock: createFreeHoopLock(),
    releaseUpdate: {
      type: "lock-release",
      peerId: lock.holderPeerId,
      timestamp,
    },
  };
}
