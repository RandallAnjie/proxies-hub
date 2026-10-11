/** Index URL rewriting so clients come back to this host with the all-style prefix. */

export function rewritePypiIndex(body: string, filesBase: string): string {
  const base = filesBase.endsWith("/") ? filesBase : filesBase + "/";
  return body.replaceAll("https://files.pythonhosted.org/", base);
}

export function rewriteNpmRegistry(body: string, npmBase: string): string {
  const base = npmBase.endsWith("/") ? npmBase : npmBase + "/";
  return body.replaceAll("https://registry.npmjs.org/", base);
}

export function rewriteCratesConfig(
  data: Record<string, unknown>,
  dlBase: string,
): Record<string, unknown> {
  return { ...data, dl: dlBase.replace(/\/$/, "") };
}

export function rewriteAbsoluteOrigin(body: string, fromOrigin: string, toBase: string): string {
  const from = fromOrigin.endsWith("/") ? fromOrigin : fromOrigin + "/";
  const to = toBase.endsWith("/") ? toBase : toBase + "/";
  return body.replaceAll(from, to);
}
