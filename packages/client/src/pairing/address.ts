import { normalizeAgentBaseUrl } from "../identity.js";

export interface AdvertisedUrlInput {
  bindHost: string;
  port: number;
  advertise?: string;
}

export function normalizeBindHost(value: string | undefined): string {
  const host = value?.trim();
  if (!host) {
    return "127.0.0.1";
  }
  return host;
}

export function localBaseHost(bindHost: string): string {
  if (bindHost === "0.0.0.0" || bindHost === "::") {
    return "127.0.0.1";
  }
  return bindHost;
}

export function buildBaseUrl(bindHost: string, port: number): string {
  return `http://${localBaseHost(bindHost)}:${port}`;
}

export function buildAdvertisedUrl(input: AdvertisedUrlInput): string {
  const advertise = input.advertise?.trim();
  if (!advertise) {
    return buildBaseUrl(input.bindHost, input.port);
  }

  if (advertise.startsWith("http://") || advertise.startsWith("https://")) {
    const url = new URL(advertise);
    if (!url.port) {
      url.port = String(input.port);
    }
    return normalizeAgentBaseUrl(url.toString().replace(/\/$/, ""));
  }

  const host = advertise.replace(/^\/+|\/+$/g, "");
  return normalizeAgentBaseUrl(`http://${host}:${input.port}`);
}

export function isLocalhostPeerUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "::1"
    );
  } catch {
    return false;
  }
}

export function describeAdvertisedAddress(peerUrl: string): string {
  if (isLocalhostPeerUrl(peerUrl)) {
    return "localhost only";
  }
  return "configured";
}
