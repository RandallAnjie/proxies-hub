/** In-memory Cache used when `caches.default` is missing (Node tests / `npm start`). */

type Entry = { status: number; statusText: string; headers: [string, string][]; body: ArrayBuffer };

export class MemoryCache implements Cache {
  private store = new Map<string, Entry>();

  async match(request: RequestInfo | URL, _options?: CacheQueryOptions): Promise<Response | undefined> {
    const key = cacheKey(request);
    const hit = this.store.get(key);
    if (!hit) return undefined;
    return new Response(hit.body.slice(0), {
      status: hit.status,
      statusText: hit.statusText,
      headers: hit.headers,
    });
  }

  async matchAll(
    _request?: RequestInfo | URL,
    _options?: CacheQueryOptions,
  ): Promise<readonly Response[]> {
    return [];
  }

  async add(_request: RequestInfo): Promise<void> {
    throw new Error("MemoryCache.add is not implemented");
  }

  async addAll(_requests: RequestInfo[]): Promise<void> {
    throw new Error("MemoryCache.addAll is not implemented");
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    if (response.status !== 200) return;
    const key = cacheKey(request);
    const body = await response.arrayBuffer();
    const headers: [string, string][] = [];
    response.headers.forEach((value, key) => {
      headers.push([key, value]);
    });
    this.store.set(key, {
      status: response.status,
      statusText: response.statusText,
      headers,
      body,
    });
  }

  async delete(request: RequestInfo | URL, _options?: CacheQueryOptions): Promise<boolean> {
    return this.store.delete(cacheKey(request));
  }

  async keys(): Promise<readonly Request[]> {
    return [...this.store.keys()].map((u) => new Request(u));
  }
}

function cacheKey(request: RequestInfo | URL): string {
  if (typeof request === "string") return request;
  if (request instanceof URL) return request.href;
  return request.url;
}
