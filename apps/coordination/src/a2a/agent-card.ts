import type { AgentCard, SecurityRequirement } from "@a2a-js/sdk";
import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import {
  PAIRMESH_ACTION_SKILL_ID,
  PAIRMESH_BEARER_FORMAT,
  PAIRMESH_BEARER_SECURITY_SCHEME,
  PAIRMESH_ECHO_SKILL_ID,
  PAIRMESH_INSPECT_SKILL_ID,
  PAIRMESH_PAYLOAD_MEDIA_TYPE,
  PAIRMESH_SESSION_SKILL_ID,
  PAIRMESH_TASK_SKILL_ID
} from "@pairmesh/protocol";
import type { PairMeshA2AAgentRuntimeConfig } from "./types.js";

const PAIRMESH_BEARER_REQUIREMENT: SecurityRequirement[] = [
  { schemes: { [PAIRMESH_BEARER_SECURITY_SCHEME]: { list: [] } } }
];

export function createPairMeshAgentCard(config: PairMeshA2AAgentRuntimeConfig): AgentCard {
  const baseUrl = `http://${config.host}:${config.port}`;
  const skills =
    config.skills === "echo-only"
      ? [
          {
            id: PAIRMESH_ECHO_SKILL_ID,
            name: "PairMesh Echo",
            description: "Demonstrates native A2A communication between PairMesh agents.",
            tags: ["pairmesh", "a2a", "demo"],
            examples: ["Hello from Paul"],
            inputModes: ["text/plain"],
            outputModes: ["text/plain"],
            securityRequirements: []
          }
        ]
      : [
          {
            id: PAIRMESH_SESSION_SKILL_ID,
            name: "PairMesh Session",
            description:
              "PairMesh session collaboration join handshake over A2A. Joining requires a single-use invite secret issued by the session creator; a successful join returns the session bearer used for all later protected calls.",
            tags: ["pairmesh", "session", "pairing"],
            examples: ["Join session PM-ABC123 with an invite secret"],
            inputModes: [PAIRMESH_PAYLOAD_MEDIA_TYPE],
            outputModes: [PAIRMESH_PAYLOAD_MEDIA_TYPE],
            securityRequirements: []
          },
          {
            id: PAIRMESH_INSPECT_SKILL_ID,
            name: "PairMesh Inspect",
            description:
              "Ask this developer's configured coding agent to inspect its local project and return read-only findings. Requires a PairMesh session bearer.",
            tags: ["pairmesh", "inspect", "debugging"],
            examples: ["What fields does the payment endpoint return?"],
            inputModes: [PAIRMESH_PAYLOAD_MEDIA_TYPE],
            outputModes: [PAIRMESH_PAYLOAD_MEDIA_TYPE],
            securityRequirements: PAIRMESH_BEARER_REQUIREMENT
          },
          {
            id: PAIRMESH_ACTION_SKILL_ID,
            name: "PairMesh Action",
            description:
              "Request a controlled action on this developer's environment (propose change, apply exact proposal, or run a named test profile). Receiver-owned approval and path policy apply. Requires a PairMesh session bearer.",
            tags: ["pairmesh", "action", "controlled"],
            examples: ["Propose a fix for the payment retry rebuild"],
            inputModes: [PAIRMESH_PAYLOAD_MEDIA_TYPE],
            outputModes: [PAIRMESH_PAYLOAD_MEDIA_TYPE],
            securityRequirements: PAIRMESH_BEARER_REQUIREMENT
          },
          {
            id: PAIRMESH_TASK_SKILL_ID,
            name: "PairMesh Collaborative Task",
            description:
              "Deliver and answer CollaborativeTask InputRequests (requester clarification). Intent only — never grants Action approval. Requires a PairMesh session bearer.",
            tags: ["pairmesh", "task", "input"],
            examples: ["Answer an InputRequest for a collaborative task"],
            inputModes: [PAIRMESH_PAYLOAD_MEDIA_TYPE],
            outputModes: [PAIRMESH_PAYLOAD_MEDIA_TYPE],
            securityRequirements: PAIRMESH_BEARER_REQUIREMENT
          },
          {
            id: PAIRMESH_ECHO_SKILL_ID,
            name: "PairMesh Echo",
            description: "Demonstrates native A2A communication between PairMesh agents.",
            tags: ["pairmesh", "a2a", "demo"],
            examples: ["Hello from Paul"],
            inputModes: ["text/plain"],
            outputModes: ["text/plain"],
            securityRequirements: []
          }
        ];

  return {
    name: config.name,
    description: "PairMesh local A2A agent with session collaboration and echo demo skills.",
    supportedInterfaces: [
      {
        url: `${baseUrl}/a2a`,
        protocolBinding: "JSONRPC",
        tenant: "",
        protocolVersion: "1.0"
      }
    ],
    provider: undefined,
    version: "0.1.0",
    documentationUrl: `${baseUrl}/${AGENT_CARD_PATH}`,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false
    },
    securitySchemes: {
      [PAIRMESH_BEARER_SECURITY_SCHEME]: {
        scheme: {
          $case: "httpAuthSecurityScheme",
          value: {
            scheme: "Bearer",
            bearerFormat: PAIRMESH_BEARER_FORMAT,
            description:
              "Opaque per-participant PairMesh session bearer issued during the invite-based join handshake."
          }
        }
      }
    },
    securityRequirements: [],
    defaultInputModes: ["text/plain", PAIRMESH_PAYLOAD_MEDIA_TYPE],
    defaultOutputModes: ["text/plain", PAIRMESH_PAYLOAD_MEDIA_TYPE],
    skills,
    signatures: [],
    iconUrl: undefined
  };
}

/** @deprecated Use createPairMeshAgentCard */
export const createPairMeshEchoAgentCard = createPairMeshAgentCard;
