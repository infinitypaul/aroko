import {
  AgentIdSchema,
  DeveloperIdSchema,
  DeviceIdSchema,
  PairMeshAgentSchema,
  PairMeshDeveloperSchema,
  PairMeshDeviceSchema,
  PairMeshProjectSchema,
  ProjectIdSchema
} from "@pairmesh/protocol";
import { randomUUID } from "node:crypto";

function prefixedId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function createLocalPairMeshIdentity(agentName: string, a2aAgentUrl?: string) {
  const developerId = DeveloperIdSchema.parse(prefixedId("dev"));
  const deviceId = DeviceIdSchema.parse(prefixedId("devc"));
  const projectId = ProjectIdSchema.parse(prefixedId("prj"));
  const agentId = AgentIdSchema.parse(prefixedId("agt"));

  const developer = PairMeshDeveloperSchema.parse({
    id: developerId,
    displayName: agentName
  });

  const device = PairMeshDeviceSchema.parse({
    id: deviceId,
    developerId,
    name: `${agentName}-device`,
    platform: process.platform
  });

  const project = PairMeshProjectSchema.parse({
    id: projectId,
    name: "pairmesh-local-a2a-demo"
  });

  const agent = PairMeshAgentSchema.parse({
    id: agentId,
    developerId,
    deviceId,
    projectId,
    name: agentName,
    adapter: "pairmesh.a2a-demo",
    ...(a2aAgentUrl ? { a2aAgentCardUrl: normalizeAgentCardUrl(a2aAgentUrl) } : {})
  });

  return { developer, device, project, agent };
}

export function normalizeAgentBaseUrl(agentUrl: string): string {
  const parsed = new URL(agentUrl);
  return parsed.origin;
}

export function normalizeAgentCardUrl(agentUrl: string): string {
  const base = normalizeAgentBaseUrl(agentUrl);
  return `${base}/.well-known/agent-card.json`;
}
