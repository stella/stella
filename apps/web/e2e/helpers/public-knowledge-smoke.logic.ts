import { Window } from "happy-dom";

import { PUBLIC_KNOWLEDGE_META } from "../../src/routes/-root-head";
import { stagingCheckDisposition, type StagingState } from "./staging-state";

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
  const window = new Window({
    settings: {
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
    },
  });
  const document = new window.DOMParser().parseFromString(html, "text/html");
  let state: "enabled" | "disabled" = "disabled";
  for (const meta of document.querySelectorAll(
    `head > meta[name="${PUBLIC_KNOWLEDGE_META.name}"]`,
  )) {
    if (meta.getAttribute("content") !== PUBLIC_KNOWLEDGE_META.content) {
      return "unexpected";
    }
    state = "enabled";
  }
  return state;
};

type PublicKnowledgeVisitorSkipOptions = {
  apiEnabled: boolean;
  webEnabled: boolean;
  state: StagingState;
};

export const publicKnowledgeVisitorSkipReason = ({
  apiEnabled,
  webEnabled,
  state,
}: PublicKnowledgeVisitorSkipOptions): string | undefined => {
  if (!apiEnabled && !webEnabled) {
    return "Public Knowledge is disabled on API and web";
  }
  if (webEnabled) {
    return undefined;
  }
  const disposition = stagingCheckDisposition(state, "public-knowledge-flags");
  if (disposition.mode === "gating") {
    return undefined;
  }
  return `Public Knowledge web routes unavailable: declared ${disposition.reason}`;
};
