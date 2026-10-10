
import {
  appendProgressEvent,
  projectInspectionProgressForRequester,
  type ProgressEvent
} from "@pairmesh/protocol";

/**
 * Merge a wire snapshot into the requester's local progressEvents.
 * Only appends events with sequence > lastSeenSequence (or unknown sequence once).
 */
export function mergeRequesterInspectProgress(
  existing: readonly ProgressEvent[] | undefined,
  incoming: readonly ProgressEvent[] | undefined
): ProgressEvent[] {
  const prior = existing ?? [];
  if (!incoming?.length) {
    return [...prior];
  }

  // Defense in depth: re-project even though receiver should already project.
  const safeIncoming = projectInspectionProgressForRequester(incoming);
  let next = [...prior];
  const seenSequences = new Set(
    prior
      .map((event) => event.sequence)
      .filter((value): value is number => typeof value === "number")
  );
  const seenMessages = new Set(
    prior
      .filter((event) => typeof event.sequence !== "number")
      .map((event) => `${event.phase}|${event.activityKind ?? ""}|${event.message ?? ""}`)
  );

  for (const event of safeIncoming) {
    if (typeof event.sequence === "number") {
      if (seenSequences.has(event.sequence)) {
        continue;
      }
      seenSequences.add(event.sequence);
      next = appendProgressEvent(next, {
        ...event,
        visibility: "requester_safe"
      });
      continue;
    }
    const key = `${event.phase}|${event.activityKind ?? ""}|${event.message ?? ""}`;
    if (seenMessages.has(key)) {
      continue;
    }
    seenMessages.add(key);
    next = appendProgressEvent(next, {
      ...event,
      visibility: "requester_safe"
    });
  }

  return next;
}
