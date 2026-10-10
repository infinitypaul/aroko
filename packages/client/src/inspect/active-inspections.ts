const activeControllers = new Map<string, AbortController>();

export function registerActiveInspection(requestId: string): AbortSignal {
  const existing = activeControllers.get(requestId);
  if (existing) {
    return existing.signal;
  }
  const controller = new AbortController();
  activeControllers.set(requestId, controller);
  return controller.signal;
}

export function clearActiveInspection(requestId: string): void {
  activeControllers.delete(requestId);
}

export function cancelActiveInspection(requestId: string): boolean {
  const controller = activeControllers.get(requestId);
  if (!controller) {
    return false;
  }
  controller.abort();
  activeControllers.delete(requestId);
  return true;
}

export function hasActiveInspection(requestId: string): boolean {
  return activeControllers.has(requestId);
}
