import { UnauthenticatedUser, type User } from "@a2a-js/sdk/server";
import type { UserBuilder } from "@a2a-js/sdk/server/express";
import {
  LocalStateStore,
  isAuthenticatedSession,
  parseBearerHeader,
  resolveInboundCredential
} from "@pairmesh/client";
import type { Request } from "express";

const UNAUTHENTICATED = new UnauthenticatedUser();

/**
 * Errors thrown from the request-handler layer surface as JSON-RPC errors. The
 * PairMesh code is embedded in the message so the calling client can translate
 * it back into a typed PairMesh error.
 */
export class PairMeshAuthorizationError extends Error {
  public readonly pairmeshCode:
    "pairmesh.authentication_required" | "pairmesh.authentication_failed";

  public constructor(
    code: "pairmesh.authentication_required" | "pairmesh.authentication_failed",
    detail: string
  ) {
    super(`${code}: ${detail}`);
    this.name = "PairMeshAuthorizationError";
    this.pairmeshCode = code;
  }
}

/**
 * Resolves the PairMesh participant behind an `Authorization: Bearer` header by
 * matching its SHA-256 hash against the credentials this session accepts.
 * Unknown, revoked, and missing credentials all yield an unauthenticated user;
 * enforcement happens in the executor and request handler.
 */
export function createPairMeshUserBuilder(stateStore: LocalStateStore): UserBuilder {
  return async (req: Request): Promise<User> => {
    const token = parseBearerHeader(req.headers.authorization);
    if (!token) {
      return UNAUTHENTICATED;
    }

    const participantId = await resolveAuthenticatedParticipant(stateStore, token);
    if (!participantId) {
      return UNAUTHENTICATED;
    }

    return {
      isAuthenticated: true,
      userName: participantId
    };
  };
}

export async function resolveAuthenticatedParticipant(
  stateStore: LocalStateStore,
  token: string
): Promise<string | undefined> {
  let state;
  try {
    state = await stateStore.load();
  } catch {
    return undefined;
  }

  if (!state || state.session.status !== "active" || !isAuthenticatedSession(state)) {
    return undefined;
  }

  const security = state.sessionSecurity;
  if (!security) {
    return undefined;
  }

  const credential = resolveInboundCredential(security, token);
  if (!credential) {
    return undefined;
  }

  // A revoked or removed peer keeps its token but loses its session membership.
  const stillMember = state.peers.some((peer) => peer.participant.id === credential.participantId);
  return stillMember ? credential.participantId : undefined;
}

/**
 * Binds A2A task ids to the participant that created them. `tasks/get` and
 * `tasks/cancel` never reach the AgentExecutor, so ownership has to be enforced
 * at the request-handler layer.
 */
export class TaskOwnershipRegistry {
  private readonly owners = new Map<string, string>();

  public claim(taskId: string, participantId: string): void {
    this.owners.set(taskId, participantId);
  }

  public ownerOf(taskId: string): string | undefined {
    return this.owners.get(taskId);
  }

  public release(taskId: string): void {
    this.owners.delete(taskId);
  }

  /** Throws unless `participantId` created `taskId`. Unknown tasks are allowed
   * through so the underlying task store can report "not found" consistently. */
  public assertOwnership(taskId: string, participantId: string): void {
    const owner = this.owners.get(taskId);
    if (owner !== undefined && owner !== participantId) {
      throw new PairMeshAuthorizationError(
        "pairmesh.authentication_failed",
        "This PairMesh task belongs to a different session participant."
      );
    }
  }
}
