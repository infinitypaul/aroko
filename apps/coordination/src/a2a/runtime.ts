import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler } from "@a2a-js/sdk/server/express";
import { createPairMeshError, parsePairMeshMetadata } from "@pairmesh/protocol";
import express, { type Request } from "express";
import { createPairMeshAgentCard } from "./agent-card.js";
import {
  TaskOwnershipRegistry,
  createPairMeshUserBuilder,
  resolveAuthenticatedParticipant
} from "./auth.js";
import { PairMeshAgentExecutor } from "./executor.js";
import { createLocalPairMeshIdentity } from "./identity.js";
import { AuthenticatedPairMeshRequestHandler } from "./request-handler.js";
import {
  LazyCodingAgentAdapter,
  LocalStateStore,
  buildLocalRuntimeHealth,
  parseBearerHeader,
  FakeCodingAgentAdapter,
  type ActionService
} from "@pairmesh/client";
import { join } from "node:path";
import {
  PairMeshA2AAgentRuntimeConfigSchema,
  type PairMeshA2AAgentRuntimeConfig
} from "./types.js";

export interface PairMeshA2AAgentServer {
  readonly name: string;
  readonly baseUrl: string;
  readonly agentCardUrl: string;
  readonly close: () => Promise<void>;
}

export interface CreatePairMeshA2AAgentOptions {
  /**
   * Share the CLI SessionManager ActionService so OwnerPresence (and other
   * record-change hooks) see inbound A2A approval_required transitions.
   */
  actionService?: ActionService;
  /**
   * R22-1: inject the runtime's authoritative LocalStateStore. When omitted
   * (tests / standalone), a store is constructed from PAIRMESH_STATE_FILE.
   */
  stateStore?: LocalStateStore;
}

export function createPairMeshA2AAgent(
  rawConfig: unknown,
  options: CreatePairMeshA2AAgentOptions = {}
): PairMeshA2AAgentServer {
  const parsed = parsePairMeshMetadata(PairMeshA2AAgentRuntimeConfigSchema, rawConfig);
  if (!parsed.ok) {
    throw parsed.error;
  }

  const config = parsed.value;
  const identity = createLocalPairMeshIdentity(config.name);
  const agentCard = createPairMeshAgentCard(config);
  const stateFilePath = process.env.PAIRMESH_STATE_FILE;
  const stateStore =
    options.stateStore ??
    (stateFilePath ? new LocalStateStore({ stateFilePath }) : new LocalStateStore());
  const workspace =
    process.env.PAIRMESH_WORKSPACE?.trim() || join(process.cwd(), "fixtures", "payment-workspace");
  const codingAgentAdapter =
    config.fakeAgentDelayMs !== undefined
      ? new LazyCodingAgentAdapter(new FakeCodingAgentAdapter(workspace, config.fakeAgentDelayMs))
      : new LazyCodingAgentAdapter();

  const taskOwnership = new TaskOwnershipRegistry();
  const requestHandler = new AuthenticatedPairMeshRequestHandler(
    new DefaultRequestHandler(
      agentCard,
      new InMemoryTaskStore(),
      new PairMeshAgentExecutor(
        stateStore,
        codingAgentAdapter,
        taskOwnership,
        options.actionService
      )
    ),
    taskOwnership,
    stateStore
  );

  const app = express();
  app.use(express.json({ limit: "100kb" }));

  app.get("/health", async (req, res) => {
    try {
      const includeOperationalDetail = await isTrustedHealthCaller(req, stateStore);
      const projectId = process.env.PAIRMESH_PROJECT_ID?.trim();
      const health = await buildLocalRuntimeHealth(
        config.name,
        codingAgentAdapter,
        stateStore,
        projectId,
        { includeOperationalDetail }
      );
      res.status(200).json(health);
    } catch {
      res.status(200).json({
        status: "unavailable",
        agent: { name: config.name },
        timestamp: new Date().toISOString(),
        readyForInspection: false
      });
    }
  });

  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
  app.use(
    "/a2a",
    jsonRpcHandler({ requestHandler, userBuilder: createPairMeshUserBuilder(stateStore) })
  );

  const server = app.listen(config.port, config.host);

  const close = async (): Promise<void> =>
    await new Promise<void>((resolve, reject) => {
      server.close((error?: Error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

  const baseUrl = `http://${config.host}:${config.port}`;
  const agentCardUrl = `${baseUrl}/${AGENT_CARD_PATH}`;

  server.on("error", (error: Error) => {
    throw createPairMeshError({
      code: "pairmesh.internal_error",
      message: "Failed to start local PairMesh A2A demo agent.",
      details: { name: config.name, reason: error.message }
    });
  });

  console.log(
    JSON.stringify(
      {
        service: "coordination",
        mode: "a2a-demo-agent",
        name: config.name,
        baseUrl,
        agentCardUrl,
        healthUrl: `${baseUrl}/health`,
        pairmeshIdentity: identity
      },
      null,
      2
    )
  );

  return {
    name: config.name,
    baseUrl,
    agentCardUrl,
    close
  };
}

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

async function isTrustedHealthCaller(req: Request, stateStore: LocalStateStore): Promise<boolean> {
  const token = parseBearerHeader(req.headers.authorization);
  if (token) {
    return (await resolveAuthenticatedParticipant(stateStore, token)) !== undefined;
  }

  const remoteAddress = req.socket.remoteAddress ?? "";
  // Same-machine callers (`doctor`, runtime readiness checks) reach the agent
  // either over loopback or over the address it binds, including an overlay IP.
  if (LOOPBACK_ADDRESSES.has(remoteAddress) || remoteAddress === req.socket.localAddress) {
    return true;
  }

  return false;
}

export function parseAgentRuntimeArgs(args: string[]): PairMeshA2AAgentRuntimeConfig {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const current = args[i];
    if (!current.startsWith("--")) {
      continue;
    }
    const key = current.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith("--")) {
      continue;
    }
    values.set(key, next);
  }

  return PairMeshA2AAgentRuntimeConfigSchema.parse({
    name: values.get("name") ?? process.env.AGENT_NAME ?? "pairmesh-agent",
    host: values.get("host") ?? process.env.AGENT_HOST ?? "127.0.0.1",
    port: Number(values.get("port") ?? process.env.PORT ?? "4101")
  });
}
