const BEARER_PREFIX = /^bearer\s+(.+)$/i;

/**
 * Extracts an opaque bearer credential from an HTTP Authorization header.
 * Returns undefined for missing, duplicated, or non-Bearer headers.
 */
export function parseBearerHeader(header: string | string[] | undefined): string | undefined {
  if (typeof header !== "string") {
    return undefined;
  }

  const match = BEARER_PREFIX.exec(header.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : undefined;
}

export function formatBearerHeader(token: string): string {
  return `Bearer ${token}`;
}

/** Wraps `fetch` so every request carries the caller's session bearer token. */
export function createBearerFetch(token: string, baseFetch: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers ?? undefined);
    headers.set("Authorization", formatBearerHeader(token));
    return await baseFetch(input, { ...init, headers });
  };
}
