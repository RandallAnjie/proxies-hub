import { config } from "./config";

export type Route =
  | { kind: "docs" }
  | { kind: "home" }
  | { kind: "help" }
  | { kind: "v2-ping" }
  | { kind: "docker"; registry: string; path: string }
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
    if (!seg || !(seg in config.docker)) {
      return { kind: "docker", registry: seg || "", path: "/v2/" + tail };
    }
    return { kind: "docker", registry: seg, path: "/v2/" + tail };
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
    "  others : /<service>/<path>       (" +
    publicServices().join(", ") +
    ")\n"
  );
}
