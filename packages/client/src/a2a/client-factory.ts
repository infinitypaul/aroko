import {
  ClientFactory,
  ClientFactoryOptions,
  JsonRpcTransportFactory,
  RestTransportFactory,
  type Client
} from "@a2a-js/sdk/client";
import type { AgentCard } from "@a2a-js/sdk";
import { createBearerFetch } from "../auth/bearer.js";
import { discoverA2AAgentCard } from "./adapter.js";
import { normalizeAgentBaseUrl } from "../identity.js";

/**
 * Builds an A2A client whose transport attaches `Authorization: Bearer <token>`
 * to every request. Agent Card discovery stays unauthenticated so peers can
 * still advertise their security schemes before pairing.
 *
 * Interface URLs from the card are rewritten onto `baseUrl`'s origin so relay
 * local-egress (and other transport façades) stay reachable. Without this,
 * cards that advertise `http://127.0.0.1:<peer-a2a>/a2a` only work on the
 * creator's machine.
 */
export async function createPairMeshA2AClient(
  baseUrl: string,
  bearerToken?: string
): Promise<Client> {
  const transportOrigin = normalizeAgentBaseUrl(baseUrl);
  const agentCard = rewriteAgentCardTransportUrls(
    await discoverA2AAgentCard(transportOrigin),
    transportOrigin
  );

  if (!bearerToken) {
    return await new ClientFactory().createFromAgentCard(agentCard);
  }

  const fetchImpl = createBearerFetch(bearerToken);
  const options = ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
    transports: [
      new JsonRpcTransportFactory({ fetchImpl }),
      new RestTransportFactory({ fetchImpl })
    ]
  });

  return await new ClientFactory(options).createFromAgentCard(agentCard);
}

/**
 * Point every `supportedInterfaces[].url` at the reachable transport origin
 * while preserving path/binding/version metadata from the peer card.
 */
export function rewriteAgentCardTransportUrls(
  agentCard: AgentCard,
  transportBaseUrl: string
): AgentCard {
  const transportOrigin = normalizeAgentBaseUrl(transportBaseUrl);
  const interfaces = agentCard.supportedInterfaces ?? [];
  if (interfaces.length === 0) {
    return agentCard;
  }

  return {
    ...agentCard,
    supportedInterfaces: interfaces.map((agentInterface) => {
      let pathname = "/a2a";
      try {
        const parsed = new URL(agentInterface.url);
        pathname = parsed.pathname || "/a2a";
      } catch {
        /* keep default /a2a */
      }
      return {
        ...agentInterface,
        url: `${transportOrigin}${pathname.startsWith("/") ? pathname : `/${pathname}`}`
      };
    })
  };
}
