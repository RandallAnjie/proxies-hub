/** Upstream + cache policy, matching config.default.yaml public services. */

export type DockerReg = { upstream: string };
export type WebMirror = {
  upstream: string;
  revalidate?: string[];
  noCache?: string[];
  /** Absolute origin rewritten in index/metadata bodies (npm packuments). */
  rewriteOrigin?: string;
};

export type AppConfig = {
  docker: Record<string, DockerReg>;
  web: Record<string, WebMirror>;
  github: {
    enabled: boolean;
    /** alias -> env binding name (e.g. team -> GITHUB_PAT) */
    tokenAliases: Record<string, string>;
  };
  apt: { enabled: boolean; scheme: "http" | "https" };
  pypi: { enabled: boolean };
  crates: { enabled: boolean };
};

export const config: AppConfig = {
  docker: {
    hub: { upstream: "https://registry-1.docker.io" },
    ghcr: { upstream: "https://ghcr.io" },
    gcr: { upstream: "https://gcr.io" },
    "k8s-gcr": { upstream: "https://k8s.gcr.io" },
    k8s: { upstream: "https://registry.k8s.io" },
    quay: { upstream: "https://quay.io" },
    mcr: { upstream: "https://mcr.microsoft.com" },
    elastic: { upstream: "https://docker.elastic.co" },
    nvcr: { upstream: "https://nvcr.io" },
    ollama: { upstream: "https://registry.ollama.ai" },
  },
  web: {
    conda: {
      upstream: "https://conda.anaconda.org",
      revalidate: [String.raw`repodata.*\.json$`, String.raw`current_repodata\.json$`],
      noCache: ["/$", String.raw`\.html$`],
    },
    torch: {
      upstream: "https://download.pytorch.org",
      noCache: ["/$", String.raw`\.html$`],
    },
    goproxy: {
      upstream: "https://proxy.golang.org",
      noCache: ["/@latest$", "/@v/list$"],
    },
    npm: {
      upstream: "https://registry.npmjs.org",
      revalidate: [String.raw`(?<!\.tgz)$`],
      rewriteOrigin: "https://registry.npmjs.org/",
    },
    hf: {
      upstream: "https://huggingface.co",
      noCache: ["^/api/"],
    },
    maven: {
      upstream: "https://repo1.maven.org/maven2",
      revalidate: [String.raw`maven-metadata\.xml$`],
      noCache: ["/$", String.raw`\.html$`],
    },
    gmaven: {
      upstream: "https://dl.google.com/dl/android/maven2",
      revalidate: [String.raw`maven-metadata\.xml$`],
      noCache: ["/$", String.raw`\.html$`],
    },
    gradle: {
      upstream: "https://plugins.gradle.org/m2",
      revalidate: [String.raw`maven-metadata\.xml$`],
      noCache: ["/$", String.raw`\.html$`],
    },
    apk: {
      upstream: "https://dl-cdn.alpinelinux.org",
      revalidate: [String.raw`APKINDEX\.tar\.gz$`],
      noCache: ["/$", String.raw`\.html$`],
    },
  },
  github: {
    enabled: true,
    tokenAliases: { team: "GITHUB_PAT" },
  },
  apt: { enabled: true, scheme: "https" },
  pypi: { enabled: true },
  crates: { enabled: true },
};

export const RANGE_CHUNK = 128 * 1024 * 1024;
/** caches.default is ~2GB/node — never put multi-GB objects in it. */
export const MAX_CACHE_BYTES = 16 * 1024 * 1024;
export const INDEX_CACHE_TTL = 7 * 24 * 3600;
export const IMMUTABLE_TTL = 31536000;
