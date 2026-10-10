import { isoNow } from "@pairmesh/shared";

export interface CoordinationBootstrapStatus {
  service: "coordination";
  healthy: true;
  startedAtIso: string;
}

export function getBootstrapStatus(): CoordinationBootstrapStatus {
  return {
    service: "coordination",
    healthy: true,
    startedAtIso: isoNow()
  };
}

console.log(JSON.stringify(getBootstrapStatus(), null, 2));
