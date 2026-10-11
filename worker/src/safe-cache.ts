/**
 * Best-effort Cache wrapper.
 *
 * RandallFlare / workerd may expose `caches.default` without a bound cache
 * service. `match`/`put` then throw (`No Cache was configured`) and used to
 * 502 the request. Every cache op is now optional: on error we log once,
 * treat it as a miss / no-op, and after repeated failures skip the cache
 * for the rest of this isolate (the wrapper is reused per Cache instance).
 *
 * A working Cache API (native or a platform shim installed on globalThis)
 * is used as designed.
 */

const FAIL_BUDGET = 2;
const HARD_FAIL = /no cache was configured/i;

type Gate = {
  disabled: boolean;
  logged: boolean;
  failures: number;
};

const wrappers = new WeakMap<Cache, SafeCache>();

export class SafeCache implements Cache {
  constructor(
    private readonly inner: Cache,
    private readonly gate: Gate,
  ) {}

  async match(
    request: RequestInfo | URL,
    options?: CacheQueryOptions,
  ): Promise<Response | undefined> {
    if (this.gate.disabled) return undefined;
    try {
      const hit = await this.inner.match(request, options);
      this.gate.failures = 0;
      return hit;
    } catch (err) {
      this.recordFailure("match", err);
      return undefined;
    }
  }

  async matchAll(
    request?: RequestInfo | URL,
    options?: CacheQueryOptions,
  ): Promise<readonly Response[]> {
    if (this.gate.disabled) return [];
    try {
      const hits = await this.inner.matchAll(request, options);
      this.gate.failures = 0;
      return hits;
    } catch (err) {
      this.recordFailure("matchAll", err);
      return [];
    }
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    if (this.gate.disabled) {
      if (response.body) void response.body.cancel();
      return;
    }
    try {
      await this.inner.put(request, response);
      this.gate.failures = 0;
    } catch (err) {
      // Individual put rejections (too large, uncacheable) are expected and
      // must not disable a working Cache. Infrastructure errors still do.
      this.recordFailure("put", err, { count: false });
    }
  }

  async delete(request: RequestInfo | URL, options?: CacheQueryOptions): Promise<boolean> {
    if (this.gate.disabled) return false;
    try {
      const ok = await this.inner.delete(request, options);
      this.gate.failures = 0;
      return ok;
    } catch (err) {
      this.recordFailure("delete", err);
      return false;
    }
  }

  async keys(
    request?: RequestInfo | URL,
    options?: CacheQueryOptions,
  ): Promise<readonly Request[]> {
    if (this.gate.disabled) return [];
    try {
      const keys = await this.inner.keys(request, options);
      this.gate.failures = 0;
      return keys;
    } catch (err) {
      this.recordFailure("keys", err);
      return [];
    }
  }

  async add(request: RequestInfo): Promise<void> {
    if (this.gate.disabled) return;
    try {
      await this.inner.add(request);
      this.gate.failures = 0;
    } catch (err) {
      this.recordFailure("add", err);
    }
  }

  async addAll(requests: RequestInfo[]): Promise<void> {
    if (this.gate.disabled) return;
    try {
      await this.inner.addAll(requests);
      this.gate.failures = 0;
    } catch (err) {
      this.recordFailure("addAll", err);
    }
  }

  private recordFailure(op: string, err: unknown, opts?: { count?: boolean }): void {
    const msg = err instanceof Error ? err.message : String(err);
    const hard = HARD_FAIL.test(msg);
    if (!this.gate.logged) {
      this.gate.logged = true;
      console.warn(
        `[proxyhub] cache ${op} failed (${msg}); treating cache as best-effort`,
      );
    }
    if (hard) {
      this.gate.disabled = true;
      return;
    }
    if (opts?.count === false) return;
    this.gate.failures += 1;
    if (this.gate.failures >= FAIL_BUDGET) this.gate.disabled = true;
  }
}

/** Reuse one wrapper per Cache so a broken `caches.default` is skipped isolate-wide. */
export function wrapCache(inner: Cache): Cache {
  if (inner instanceof SafeCache) return inner;
  let wrapped = wrappers.get(inner);
  if (!wrapped) {
    wrapped = new SafeCache(inner, { disabled: false, logged: false, failures: 0 });
    wrappers.set(inner, wrapped);
  }
  return wrapped;
}

/** Resolve `globalThis.caches.default` without throwing if the getter is broken. */
export function nativeDefaultCache(): Cache | undefined {
  try {
    if (typeof globalThis === "undefined" || !("caches" in globalThis)) return undefined;
    return (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
  } catch {
    return undefined;
  }
}
