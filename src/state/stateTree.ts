export interface QueueItem {
  id: string;
  type: string;
  payload: unknown;
  createdAt: string;
}

export interface SidelineItem {
  id: string;
  type: string;
  payload: unknown;
  createdAt: string;
  reason: string;
}

export interface StateTree {
  queue: QueueItem[];
  sidelinePool: SidelineItem[];
  metadata: Record<string, unknown>;
}

export function createEmptyStateTree(): StateTree {
  return {
    queue: [],
    sidelinePool: [],
    metadata: {},
  };
}
