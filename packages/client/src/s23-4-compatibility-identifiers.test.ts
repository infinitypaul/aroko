/**
 * S23-4 protocol / wire identity tripwire — branding must not change these.
 */
import { describe, expect, it } from "vitest";
import {
  PAIRMESH_SESSION_SKILL_ID,
  PAIRMESH_ECHO_SKILL_ID,
  PAIRMESH_INSPECT_SKILL_ID,
  PAIRMESH_ACTION_SKILL_ID,
  PAIRMESH_TASK_SKILL_ID,
  PAIRMESH_PAYLOAD_MEDIA_TYPE,
  PAIRMESH_BEARER_SECURITY_SCHEME
} from "@pairmesh/protocol";
import { PAIRMESH_DIR_NAME } from "./local-config/paths.js";
import { SENSITIVE_PATH_SEGMENTS } from "./action/proposal/paths.js";

describe("S23-4 compatibility identifiers preserved", () => {
  it("keeps protocol skill IDs", () => {
    expect(PAIRMESH_SESSION_SKILL_ID).toBe("pairmesh.session");
    expect(PAIRMESH_ECHO_SKILL_ID).toBe("pairmesh.echo");
    expect(PAIRMESH_INSPECT_SKILL_ID).toBe("pairmesh.inspect");
    expect(PAIRMESH_ACTION_SKILL_ID).toBe("pairmesh.action");
    expect(PAIRMESH_TASK_SKILL_ID).toBe("pairmesh.task");
  });

  it("keeps media type and bearer scheme", () => {
    expect(PAIRMESH_PAYLOAD_MEDIA_TYPE).toBe("application/vnd.pairmesh+json");
    expect(PAIRMESH_BEARER_SECURITY_SCHEME).toBe("pairmeshSessionBearer");
  });

  it("keeps .pairmesh control directory and Stage 22 deny segment", () => {
    expect(PAIRMESH_DIR_NAME).toBe(".pairmesh");
    expect(SENSITIVE_PATH_SEGMENTS.has(".pairmesh")).toBe(true);
  });
});
