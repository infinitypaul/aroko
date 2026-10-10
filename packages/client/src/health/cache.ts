const DEFAULT_TTL_MS = 3_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class HealthCache<T> {
  private entry: CacheEntry<T> | undefined;
  private readonly ttlMs: number;

  public constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  public get(): T | undefined {
    if (!this.entry || Date.now() >= this.entry.expiresAt) {
      return undefined;
    }
    return this.entry.value;
  }

  public set(value: T): void {
    this.entry = { value, expiresAt: Date.now() + this.ttlMs };
  }

  public clear(): void {
    this.entry = undefined;
  }
}
