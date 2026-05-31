import { Result } from "better-result";

import { parseSafeOutboundUrl } from "@/api/lib/safe-outbound-fetch";

type HuggingFaceBaseURLResult =
  | { ok: true; baseURL: string }
  | { ok: false; error: string };

export const normalizeHuggingFaceBaseURL = (
  rawEndpoint: string,
): HuggingFaceBaseURLResult => {
  const safeURL = parseSafeOutboundUrl(rawEndpoint.trim());
  if (Result.isError(safeURL)) {
    return {
      ok: false,
      error: safeURL.error.message.replace(/^URL\b/u, "Hugging Face endpoint"),
    };
  }

  const parsed = safeURL.value;
  if (parsed.search || parsed.hash) {
    return {
      ok: false,
      error:
        "Hugging Face endpoint must not include query parameters or fragments",
    };
  }

  return {
    ok: true,
    baseURL: `${parsed.origin}${trimTrailingSlashes(parsed.pathname)}`,
  };
};

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
