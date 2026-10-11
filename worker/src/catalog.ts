import { config } from "./config";
import { CRATES_INDEX } from "./crates";
import { PYPI_SIMPLE } from "./pypi";
import { publicDockerRegistries, publicServices } from "./route";

export type CatalogItem = {
  id: string;
  prefix: string;
  upstream: string;
  family: "docker" | "service";
};

function serviceUpstream(id: string): string {
  if (id in config.web) return config.web[id].upstream;
  if (id === "github") return "https://github.com";
  if (id === "pypi") return PYPI_SIMPLE;
  if (id === "crates") return CRATES_INDEX;
  if (id === "apt") return `${config.apt.scheme}://<host>/<path>`;
  if (id === "cache") return "https://<host>/<path>";
  return "";
}

/** Every public docker registry + path-dispatched service, from live config. */
export function catalogItems(): CatalogItem[] {
  const docker = publicDockerRegistries().map((id) => ({
    id,
    prefix: `/v2/${id}`,
    upstream: config.docker[id].upstream,
    family: "docker" as const,
  }));
  const services = publicServices().map((id) => ({
    id,
    prefix: `/${id}`,
    upstream: serviceUpstream(id),
    family: "service" as const,
  }));
  return [...docker, ...services];
}
