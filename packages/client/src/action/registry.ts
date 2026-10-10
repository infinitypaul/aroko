import {
  createPairMeshError,
  type ActionMutability,
  type PairMeshGrantableCapabilityId
} from "@pairmesh/protocol";

export type FakeExecutorMode =
  "success" | "delayed_success" | "failure" | "cancel" | "unknown_outcome" | "partial_completion";

export interface ActionTypeDefinition {
  actionType: string;
  capabilityId: PairMeshGrantableCapabilityId;
  mutability: ActionMutability;
  requiresArtifact: boolean;
  requiresApproval: boolean;
  allowSessionApproval: boolean;
  requiresCapabilityIds?: PairMeshGrantableCapabilityId[];
  executable: boolean;
  description: string;
}

const REGISTRY: readonly ActionTypeDefinition[] = [
  {
    actionType: "pairmesh.test.noop",
    capabilityId: "change.propose",
    mutability: "none",
    requiresArtifact: false,
    requiresApproval: false,
    allowSessionApproval: true,
    requiresCapabilityIds: ["repository.inspect"],
    executable: true,
    description: "Deterministic non-mutating fake action for Stage 15 Prompt 2."
  },
  {
    actionType: "pairmesh.test.artifact_apply",
    capabilityId: "repository.edit",
    mutability: "mutation",
    requiresArtifact: true,
    requiresApproval: true,
    allowSessionApproval: false,
    executable: true,
    description: "Deterministic mutating fake apply that never touches the working tree."
  },
  {
    actionType: "pairmesh.test.run_profile",
    capabilityId: "tests.run",
    mutability: "mutation",
    requiresArtifact: false,
    requiresApproval: true,
    allowSessionApproval: false,
    executable: true,
    description: "Fake named-profile test runner (no real process spawn in Prompt 2)."
  },
  {
    actionType: "change.propose",
    capabilityId: "change.propose",
    mutability: "proposal",
    requiresArtifact: false,
    requiresApproval: false,
    allowSessionApproval: true,
    requiresCapabilityIds: ["repository.inspect"],
    executable: true,
    description:
      "Generate an immutable proposal artifact via a proposal-only coding-agent path; does not mutate the working tree."
  },
  {
    actionType: "repository.edit",
    capabilityId: "repository.edit",
    mutability: "mutation",
    requiresArtifact: true,
    requiresApproval: true,
    allowSessionApproval: false,
    executable: true,
    description:
      "Apply exactly one receiver-approved immutable proposal artifact via PairMesh-owned patch applicator (no provider write tools)."
  },
  {
    actionType: "tests.run",
    capabilityId: "tests.run",
    mutability: "mutation",
    requiresArtifact: false,
    requiresApproval: false,
    allowSessionApproval: true,
    executable: true,
    description:
      "Run a receiver-owned named test profile (profile name only; no remote argv/shell)."
  },
  {
    actionType: "process.execute",
    capabilityId: "process.execute",
    mutability: "mutation",
    requiresArtifact: false,
    requiresApproval: true,
    allowSessionApproval: false,
    executable: true,
    description:
      "Run an approved structured process (basename + argv; shell:false; allow-once only)."
  }
];

export function listActionTypeDefinitions(): ActionTypeDefinition[] {
  return REGISTRY.map((entry) => ({ ...entry }));
}

export function getActionTypeDefinition(actionType: string): ActionTypeDefinition | undefined {
  return REGISTRY.find((entry) => entry.actionType === actionType);
}

export function requireActionTypeDefinition(actionType: string): ActionTypeDefinition {
  const definition = getActionTypeDefinition(actionType);
  if (!definition) {
    throw createPairMeshError({
      code: "pairmesh.action_unsupported",
      message: `Unknown action type: ${actionType}`
    });
  }
  return definition;
}
