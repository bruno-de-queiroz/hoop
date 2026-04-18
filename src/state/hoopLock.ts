export interface HoopLock {
  holderPeerId: string | null;
  acquiredAt: number | null;
  status: "free" | "busy";
}

export const HOOP_LOCK_TTL_MS = 5 * 60_000;

export function createFreeHoopLock(): HoopLock {
  return {
    holderPeerId: null,
    acquiredAt: null,
    status: "free",
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
