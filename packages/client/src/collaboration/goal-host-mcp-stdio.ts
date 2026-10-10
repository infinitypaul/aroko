/**
 * PairMesh goal-mode host-tool MCP (stdio).
 *
 * Exposes structured `request_*` tools for Claude Code / Cursor ACP.
 * Ack-only: does not approve, execute, or bypass Aroko. HostRequestBridge
 * is invoked by GoalTaskWorker from the provider's structured tool event.
 *
 * Uses the official MCP SDK (`serveStdio`) so Claude Code 2.1+ modern-era
 * negotiation succeeds (hand-rolled Content-Length-only servers can stay
 * `pending` forever against current Claude MCP clients).
 *
 * Run: `node …/goal-host-mcp-stdio.js`
 */
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";
import { PAIRMESH_GOAL_HOST_TOOLS } from "./goal-host-tools.js";

const SERVER_NAME = "pairmesh_goal";
const SERVER_VERSION = "0.1.0";

function ack(toolName: string): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [
      {
        type: "text",
        text: [
          `Aroko recorded structured host tool call: ${toolName}.`,
          "This is not approval and does not execute the action.",
          "Stop this provider turn now. Wait for Aroko continuation."
        ].join(" ")
      }
    ]
  };
}

function createGoalHostMcpServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION
  });

  server.registerTool(
    "request_requester_input",
    {
      description: PAIRMESH_GOAL_HOST_TOOLS[0]!.description,
      inputSchema: z.object({
        question: z.string().min(1).max(2048),
        options: z.array(z.string().min(1).max(200)).max(6).optional(),
        allowFreeText: z.boolean().optional()
      })
    },
    async () => ack("request_requester_input")
  );

  server.registerTool(
    "request_change_proposal",
    {
      description: PAIRMESH_GOAL_HOST_TOOLS[1]!.description,
      inputSchema: z.object({
        instruction: z.string().min(1).max(8000)
      })
    },
    async () => ack("request_change_proposal")
  );

  server.registerTool(
    "request_repository_edit",
    {
      description: PAIRMESH_GOAL_HOST_TOOLS[2]!.description,
      inputSchema: z.object({
        artifactId: z.string().min(1).max(80),
        contentHash: z.string().regex(/^[a-f0-9]{64}$/)
      })
    },
    async () => ack("request_repository_edit")
  );

  server.registerTool(
    "request_tests_run",
    {
      description: PAIRMESH_GOAL_HOST_TOOLS[3]!.description,
      inputSchema: z.object({
        profileName: z
          .string()
          .min(1)
          .max(80)
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
      })
    },
    async () => ack("request_tests_run")
  );

  server.registerTool(
    "request_process_execution",
    {
      description: PAIRMESH_GOAL_HOST_TOOLS[4]!.description,
      inputSchema: z
        .object({
          executable: z.string().min(1).max(200),
          args: z.array(z.string().max(2000)).max(64),
          cwd: z.string().min(1).max(500).optional(),
          timeoutMs: z.number().int().positive().max(3_600_000).optional()
        })
        .strict()
    },
    async () => ack("request_process_execution")
  );

  return server;
}

await serveStdio(() => createGoalHostMcpServer());
