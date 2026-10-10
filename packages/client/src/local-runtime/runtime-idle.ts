
import { isWatchableActiveAction, isWatchableActiveInspection } from "../action/watch-present.js";

export interface RuntimeBusySnapshot {
  idle: boolean;
  busyReasons: string[];
  activeActionCount: number;
  activeInspectionCount: number;
}

export function evaluateRuntimeBusy(input: {
  actions: Array<{ status?: string; terminal?: boolean; actionLabel?: string }>;
  inspections: Array<{ status?: string; terminal?: boolean }>;
}): RuntimeBusySnapshot {
  const activeActions = input.actions.filter((entry) => isWatchableActiveAction(entry));
  const activeInspections = input.inspections.filter((entry) => isWatchableActiveInspection(entry));
  const busyReasons: string[] = [];
  if (activeInspections.length > 0) {
    busyReasons.push(
      activeInspections.length === 1
        ? "active inspection"
        : `${activeInspections.length} active inspections`
    );
  }
  if (activeActions.length > 0) {
    busyReasons.push(
      activeActions.length === 1 ? "active action" : `${activeActions.length} active actions`
    );
  }
  return {
    idle: busyReasons.length === 0,
    busyReasons,
    activeActionCount: activeActions.length,
    activeInspectionCount: activeInspections.length
  };
}
