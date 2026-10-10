import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { createCodingAgentError } from "./types.js";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message: string; data?: unknown };
}

export class AcpJsonRpcClient {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  private nextId = 1;
  private readonly notificationHandlers = new Map<
    string,
    (params: unknown) => void | Promise<void>
  >();
  private readonly requestHandlers = new Map<
    string,
    (params: unknown, id: number) => unknown | Promise<unknown>
  >();
  private closed = false;

  public constructor(command: string, args: string[], cwd: string) {
    this.process = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });

    const rl = readline.createInterface({ input: this.process.stdout });
    rl.on("line", (line) => {
      void this.handleLine(line);
    });

    this.process.on("error", (error) => {
      this.rejectAll(createCodingAgentError("agent_unavailable", error.message));
    });

    this.process.on("exit", (code) => {
      if (!this.closed) {
        this.rejectAll(
          createCodingAgentError(
            "agent_execution_failed",
            `ACP process exited with code ${code ?? "unknown"}.`
          )
        );
      }
    });
  }

  public onNotification(method: string, handler: (params: unknown) => void | Promise<void>): void {
    this.notificationHandlers.set(method, handler);
  }

  public onRequest(
    method: string,
    handler: (params: unknown, id: number) => unknown | Promise<unknown>
  ): void {
    this.requestHandlers.set(method, handler);
  }

  public async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    this.process.stdin.write(`${JSON.stringify(payload)}\n`);

    return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.process.stdin.end();
    await new Promise<void>((resolve) => {
      this.process.once("exit", () => resolve());
      this.process.kill();
    });
  }

  private async handleLine(line: string): Promise<void> {
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(line) as JsonRpcRequest;
    } catch {
      return;
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const waiter = this.pending.get(message.id);
      if (!waiter) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        waiter.reject(new Error(message.error.message));
      } else {
        waiter.resolve(message.result);
      }
      return;
    }

    if (message.method && message.id !== undefined) {
      const handler = this.requestHandlers.get(message.method);
      if (!handler) {
        this.respond(message.id, {
          error: { code: -32601, message: `Method not found: ${message.method}` }
        });
        return;
      }

      try {
        const result = await handler(message.params, message.id);
        this.respond(message.id, { result });
      } catch (error) {
        this.respond(message.id, {
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error)
          }
        });
      }
      return;
    }

    if (message.method) {
      const handler = this.notificationHandlers.get(message.method);
      if (handler) {
        await handler(message.params);
      }
    }
  }

  private respond(
    id: number,
    payload: { result?: unknown; error?: { code: number; message: string } }
  ): void {
    this.process.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, ...payload }) + "\n");
  }

  private rejectAll(error: unknown): void {
    for (const [, waiter] of this.pending) {
      waiter.reject(error);
    }
    this.pending.clear();
  }
}

export async function assertCommandAvailable(command: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, ["--version"], { stdio: "ignore" });
    child.on("error", () => {
      reject(
        createCodingAgentError(
          "agent_unavailable",
          "Cursor CLI is not installed or not available in PATH."
        )
      );
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        createCodingAgentError(
          "agent_unavailable",
          "Cursor CLI is not installed or not available in PATH."
        )
      );
    });
  });
}
