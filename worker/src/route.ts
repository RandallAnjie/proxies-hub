import { config } from "./config";
import type { DockerTokenTarget } from "./docker";
import { decodeHostSegment } from "./registry-host";

export type Route =
  | { kind: "docs" }
  | { kind: "home" }
  | { kind: "help" }
  | { kind: "v2-ping" }
  | { kind: "docker"; registry: string; path: string }
  | { kind: "docker-generic"; registryHost: string; path: string }
  | { kind: "docker-token"; target: DockerTokenTarget }
  | { kind: "service"; service: string; path: string; prefix: string };

const SERVICES = new Set<string>([
  ...Object.keys(config.web),
  "cache",
  ...(config.github.enabled ? ["github"] : []),
  ...(config.apt.enabled ? ["apt"] : []),
  ...(config.pypi.enabled ? ["pypi"] : []),
  ...(config.crates.enabled ? ["crates"] : []),
]);

export function publicDockerRegistries(): string[] {
  return Object.keys(config.docker).sort();
}

export function publicServices(): string[] {
  return [...SERVICES].sort();
}

/** Path dispatch matching `AllProxy.handle` plus `/docs` on this host. */
export function matchRoute(pathname: string): Route {
  const path = pathname === "" ? "/" : pathname;
  if (path === "/") return { kind: "home" };
  if (path === "/docs" || path === "/docs/") return { kind: "docs" };
  if (path === "/v2" || path === "/v2/") return { kind: "v2-ping" };
  if (path.startsWith("/v2/")) {
    const rest = path.slice(4);
    const slash = rest.indexOf("/");
    const seg = slash === -1 ? rest : rest.slice(0, slash);
    const tail = slash === -1 ? "" : rest.slice(slash + 1);
    if (seg === "r") {
      const hostSlash = tail.indexOf("/");
      const hostSeg = hostSlash === -1 ? tail : tail.slice(0, hostSlash);
      const after = hostSlash === -1 ? "" : tail.slice(hostSlash + 1);
      return {
        kind: "docker-generic",
        registryHost: decodeHostSegment(hostSeg),
        path: "/v2/" + after,
      };
    }
    if (!seg || !(seg in config.docker)) {
      return { kind: "docker", registry: seg || "", path: "/v2/" + tail };
    }
    return { kind: "docker", registry: seg, path: "/v2/" + tail };
  }
  if (path.startsWith("/token/")) {
    const rest = path.slice(7);
    if (rest === "r" || rest.startsWith("r/")) {
      const host = rest === "r" ? "" : rest.slice(2);
      return {
        kind: "docker-token",
        target: { kind: "generic", registryHost: decodeHostSegment(host) },
      };
    }
    if (rest && rest in config.docker && !rest.includes("/")) {
      return { kind: "docker-token", target: { kind: "fixed", registry: rest } };
    }
  }
  const stripped = path.replace(/^\/+/, "");
  const slash = stripped.indexOf("/");
  const seg = slash === -1 ? stripped : stripped.slice(0, slash);
  const tail = slash === -1 ? "" : stripped.slice(slash + 1);
  if (!seg || !SERVICES.has(seg)) return { kind: "help" };
  return {
    kind: "service",
    service: seg,
    path: "/" + tail,
    prefix: "/" + seg,
  };
}

export function helpText(): string {
  return (
    "proxyhub — all-in-one entrypoint\n\n" +
    "  docker : /v2/<registry>/<repo>   (public: " +
    publicDockerRegistries().join(", ") +
    ")\n" +
    "           /v2/r/<registry-host>/<repo>  (any OCI registry; docker login <host> for private)\n" +
    "  others : /<service>/<path>       (" +
    publicServices().join(", ") +
    ")\n"
  );
}
