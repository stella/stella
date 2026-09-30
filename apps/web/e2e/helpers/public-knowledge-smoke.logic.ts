import messages from "../../src/i18n/langs/en.json" with { type: "json" };

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

/** Classify served markup, never the status of a client-only shell. */
export const classifyPublicKnowledgeWebProbe = (
  html: string,
): "enabled" | "disabled" | "unexpected" => {
  const markup = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, "")
    .replace(/<!--[\s\S]*?-->/gu, "");
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/iu.exec(markup)?.at(1)?.trim();
  if (!body) {return "unexpected";}

  for (const heading of body.matchAll(/<h1\b[^>]*>([^<]*)<\/h1>/giu)) {
    if (heading.at(1)?.trim() === messages.publicTools.contribute.title) {
      return "enabled";
    }
  }

  // Flag-off routes serve only the root loading fallback with SSR disabled.
  const loadingShell =
    /^<div\b[^>]*>\s*<span\b(?=[^>]*\bdata-slot="loader")[^>]*>\s*<svg\b[^>]*>[\s\S]*?<\/svg>\s*<\/span>\s*<\/div>$/iu;
  if (
    loadingShell.test(body) &&
    html.includes('data-tsr-stream-part=""') &&
    html.includes("ssr:!1")
  ) {
    return "disabled";
  }
  return "unexpected";
};
