export type Env = {
  GITHUB_PAT?: string;
  [key: string]: string | undefined;
};

export type ExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
};

export type FetchFn = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type Runtime = {
  fetch: FetchFn;
  cache: Cache;
  now: () => number;
  waitUntil: (p: Promise<unknown>) => void;
  /** Override Range chunk size (tests). */
  rangeChunk: number;
  maxCacheBytes: number;
};

export type Ctx = {
  request: Request;
  env: Env;
  url: URL;
  origin: string;
  host: string;
  runtime: Runtime;
};
