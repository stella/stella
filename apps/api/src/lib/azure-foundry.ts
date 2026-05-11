import { validateSafeBaseURL } from "@/api/lib/safe-base-url";

export const AZURE_FOUNDRY_DEFAULT_API_VERSION = "2024-06-01";

export type AzureFoundryBaseURLResult =
  | { ok: true; baseURL: string }
  | { ok: false; error: string };

/**
 * Normalize an Azure AI Foundry / Azure OpenAI endpoint into the
 * baseURL shape expected by @ai-sdk/azure. The provider appends
 * `/v1{path}` itself, so user-pasted `/openai/v1` endpoints are
 * stored without the trailing `/v1`.
 */
export const normalizeAzureFoundryBaseURL = (
  rawEndpoint: string,
): AzureFoundryBaseURLResult => {
  const safeURL = validateSafeBaseURL(rawEndpoint.trim());
  if (!safeURL.ok) {
    return { ok: false, error: safeURL.error.replace("Base URL", "Endpoint") };
  }

  const parsed = new URL(safeURL.url);
  if (parsed.search || parsed.hash) {
    return {
      ok: false,
      error: "Endpoint must not include query parameters or fragments",
    };
  }

  const path = normalizeEndpointPath({
    hostname: parsed.hostname,
    pathname: parsed.pathname,
  });
  if (!path.ok) {
    return path;
  }

  return {
    ok: true,
    baseURL: `${parsed.origin}${path.pathname}`,
  };
};

type EndpointPathResult =
  | { ok: true; pathname: string }
  | { ok: false; error: string };

type NormalizeEndpointPathOptions = {
  hostname: string;
  pathname: string;
};

const normalizeEndpointPath = ({
  hostname,
  pathname: rawPathname,
}: NormalizeEndpointPathOptions): EndpointPathResult => {
  const pathname = trimTrailingSlashes(rawPathname);

  if (pathname === "") {
    if (!isAzureOpenAIResourceHost(hostname)) {
      return {
        ok: false,
        error:
          "Endpoint must include /openai/v1 unless it is an Azure OpenAI resource host",
      };
    }
    return { ok: true, pathname: "/openai" };
  }

  if (pathname === "/openai") {
    return { ok: true, pathname };
  }

  if (pathname === "/openai/v1") {
    return { ok: true, pathname: "/openai" };
  }

  if (pathname.startsWith("/api/projects/")) {
    if (pathname.endsWith("/openai")) {
      return { ok: true, pathname };
    }
    if (pathname.endsWith("/openai/v1")) {
      return {
        ok: true,
        pathname: pathname.slice(0, -"/v1".length),
      };
    }
    return { ok: true, pathname: `${pathname}/openai` };
  }

  return {
    ok: false,
    error:
      "Endpoint must be an Azure OpenAI /openai/v1 endpoint or an Azure Foundry project endpoint",
  };
};

const isAzureOpenAIResourceHost = (hostname: string): boolean =>
  hostname.toLowerCase().endsWith(".openai.azure.com");

const trimTrailingSlashes = (value: string): string => {
  let end = value.length;
  while (end > 1 && value[end - 1] === "/") {
    end -= 1;
  }
  if (end === 1 && value === "/") {
    return "";
  }
  return value.slice(0, end);
};
