import { loadLocalCodingAgentConfigFromEnv, toAdapterOptions } from "./config.js";
import { createCodingAgentAdapter } from "./registry.js";
import { FakeCodingAgentAdapter } from "./fake-adapter.js";
import { probeCodingAgentAvailability } from "./availability.js";
import { CODING_AGENT_OWNER_VISIBILITY } from "./provider-visibility.js";
import {
  createCodingAgentError,
  type CodingAgentAdapter,
  type CodingAgentAvailability,
  type CodingAgentInspectOptions,
  type CodingAgentProposeOptions,
  type CodingAgentProposeRequest,
  type CodingAgentProposeResult,
  type CodingAgentProviderDescriptor,
  type CodingAgentRequest,
  type CodingAgentResult
} from "./types.js";

const LAZY_PLACEHOLDER: CodingAgentProviderDescriptor = {
  id: "cursor",
  displayName: "PairMesh Coding Agent (lazy)",
  capabilities: {
    inspect: true,
    followUp: true,
    sourceReferences: true,
    cancellation: true,
    nativeSessionResume: true,
    proposeChange: false
  },
  ownerVisibility: CODING_AGENT_OWNER_VISIBILITY.cursor
};

export class LazyCodingAgentAdapter implements CodingAgentAdapter {
  private adapterPromise: Promise<CodingAgentAdapter> | undefined;
  private readonly wrappedAdapter: CodingAgentAdapter | undefined;
  private resolvedProvider: CodingAgentProviderDescriptor;

  public constructor(wrappedAdapter?: CodingAgentAdapter) {
    this.wrappedAdapter = wrappedAdapter;
    this.resolvedProvider = wrappedAdapter?.provider ?? LAZY_PLACEHOLDER;
  }

  public get provider(): CodingAgentProviderDescriptor {
    return this.resolvedProvider;
  }

  public async getAvailability(): Promise<CodingAgentAvailability> {
    if (this.wrappedAdapter) {
      return await this.wrappedAdapter.getAvailability();
    }

    try {
      const config = await loadLocalCodingAgentConfigFromEnv();
      return await probeCodingAgentAvailability({
        provider: config.provider,
        workspace: config.workspace,
        command: config.command
      });
    } catch (error) {
      return {
        provider: "cursor",
        configured: false,
        status: "unavailable",
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  }

  public inspect(
    request: CodingAgentRequest,
    options?: CodingAgentInspectOptions
  ): Promise<CodingAgentResult> {
    return this.resolveAdapter().then((adapter) => adapter.inspect(request, options));
  }

  /**
   * Forward proposal-only generation to the resolved provider.
   * Required for A2A `change.propose`: ActionService wraps this lazy adapter and
   * must not treat the unresolved placeholder (`proposeChange: false`) as final.
   */
  public async proposeChange(
    request: CodingAgentProposeRequest,
    options?: CodingAgentProposeOptions
  ): Promise<CodingAgentProposeResult> {
    const adapter = await this.resolveAdapter();
    this.resolvedProvider = adapter.provider;
    if (
      !adapter.provider.capabilities.proposeChange ||
      typeof adapter.proposeChange !== "function"
    ) {
      throw createCodingAgentError(
        "agent_execution_failed",
        `Provider ${adapter.provider.id} has no proposeChange implementation.`
      );
    }
    return adapter.proposeChange(request, options);
  }

  public async cancelActiveInspection(): Promise<boolean> {
    const adapter = await this.resolveAdapter();
    if (
      "cancelActiveInspection" in adapter &&
      typeof adapter.cancelActiveInspection === "function"
    ) {
      return await (
        adapter as CodingAgentAdapter & { cancelActiveInspection: () => Promise<boolean> }
      ).cancelActiveInspection();
    }
    return false;
  }

  private resolveAdapter(): Promise<CodingAgentAdapter> {
    if (this.wrappedAdapter) {
      return Promise.resolve(this.wrappedAdapter);
    }

    if (!this.adapterPromise) {
      this.adapterPromise = loadLocalCodingAgentConfigFromEnv().then((config) => {
        const adapter =
          config.provider === "fake"
            ? new FakeCodingAgentAdapter(config.workspace, config.fakeAgentDelayMs)
            : createCodingAgentAdapter(config.provider, toAdapterOptions(config));
        this.resolvedProvider = adapter.provider;
        return adapter;
      });
    }
    return this.adapterPromise;
  }
}
