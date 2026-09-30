import { PUBLIC_KNOWLEDGE_META } from "../../src/lib/root-head";

const normalizeMountedApiPath = (pathname: string): string =>
  pathname.replace(/^\/api(?=\/(?:v1|auth)(?:\/|$))/u, "");

const PUBLIC_AUTH_PATHS = new Set(["/auth/get-session"]);

type SmokeRequestOptions = {
  pathname: string;
  method: string;
};

export const isMemberOnlySmokeRequest = ({
  pathname,
  method,
}: SmokeRequestOptions): boolean => {
  const normalizedPath = normalizeMountedApiPath(pathname);

  if (normalizedPath === "/auth" || normalizedPath.startsWith("/auth/")) {
    return method !== "GET" || !PUBLIC_AUTH_PATHS.has(normalizedPath);
  }

  if (normalizedPath === "/v1" || normalizedPath.startsWith("/v1/")) {
    return !normalizedPath.startsWith("/v1/public/");
  }

  return false;
};

/** Read the explicit root-head signal without matching script contents. */
export const classifyPublicKnowledgeWebProbe = (
  html: string,
): "enabled" | "disabled" | "unexpected" => {
  const markup = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, "")
    .replace(/<!--[\s\S]*?-->/gu, "");
  const head = /<head\b[^>]*>([\s\S]*?)<\/head>/iu.exec(markup)?.at(1) ?? "";
  let state: "enabled" | "disabled" = "disabled";
  for (const meta of head.matchAll(
    /<meta\b((?:"[^"]*"|'[^']*'|[^'">])*)>/giu,
  )) {
    const attributes = new Map<string, string>();
    for (const attribute of (meta.at(1) ?? "").matchAll(
      /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu,
    )) {
      const name = attribute.at(1);
      if (name) {
        attributes.set(
          name.toLowerCase(),
          attribute.at(2) ?? attribute.at(3) ?? attribute.at(4) ?? "",
        );
      }
    }
    if (attributes.get("name") !== PUBLIC_KNOWLEDGE_META.name) {
      continue;
    }
    if (attributes.get("content") !== PUBLIC_KNOWLEDGE_META.content) {
      return "unexpected";
    }
    state = "enabled";
  }
  return state;
};
