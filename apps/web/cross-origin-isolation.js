const OUTLOOK_SIGN_IN_PATH = "/sign-in-outlook";
const OUTLOOK_REDIRECT_MAX_CHARS = 2048;
const OUTLOOK_REDIRECT_MAX_DEPTH = 4;

const DEFAULT_CROSS_ORIGIN_ISOLATION_HEADERS = {
  "Cross-Origin-Embedder-Policy": "credentialless",
  "Cross-Origin-Opener-Policy": "same-origin",
};

/**
 * @param {URL} url Candidate handoff URL.
 * @param {string} [allowedParentOrigin] Configured Outlook origin.
 */
const isOutlookHandoffUrl = (url, allowedParentOrigin) => {
  if (url.pathname !== OUTLOOK_SIGN_IN_PATH) {
    return false;
  }
  const parentOrigin = url.searchParams.get("parentOrigin");
  if (!parentOrigin || !allowedParentOrigin) {
    return false;
  }
  try {
    const parent = new URL(parentOrigin);
    return (
      parent.protocol === "https:" &&
      parent.origin === parentOrigin &&
      parentOrigin === allowedParentOrigin
    );
  } catch {
    return false;
  }
};

/**
 * @param {URL} url Candidate auth-flow URL.
 * @param {string} [allowedParentOrigin] Configured Outlook origin.
 */
const isOutlookDialogFlowUrl = (url, allowedParentOrigin) => {
  if (isOutlookHandoffUrl(url, allowedParentOrigin)) {
    return true;
  }
  if (
    !(
      url.pathname === "/auth" ||
      url.pathname.startsWith("/auth/") ||
      url.pathname === "/onboarding"
    )
  ) {
    return false;
  }

  let redirectTo = url.searchParams.get("redirectTo");
  for (
    let depth = 0;
    redirectTo && depth < OUTLOOK_REDIRECT_MAX_DEPTH;
    depth++
  ) {
    if (redirectTo.length > OUTLOOK_REDIRECT_MAX_CHARS) {
      return false;
    }
    let redirectUrl;
    try {
      redirectUrl = new URL(redirectTo, url.origin);
    } catch {
      return false;
    }
    if (redirectUrl.origin !== url.origin) {
      return false;
    }
    if (isOutlookHandoffUrl(redirectUrl, allowedParentOrigin)) {
      return true;
    }
    redirectTo = redirectUrl.searchParams.get("redirectTo");
  }
  return false;
};

/**
 * @param {URL} url Incoming request URL.
 * @param {string} [allowedParentOrigin] Configured Outlook origin.
 * @returns {Record<string, string>} Headers for this request.
 */
export const crossOriginIsolationHeadersForRequest = (
  url,
  allowedParentOrigin,
) => ({
  ...DEFAULT_CROSS_ORIGIN_ISOLATION_HEADERS,
  ...(isOutlookDialogFlowUrl(url, allowedParentOrigin)
    ? { "Cross-Origin-Opener-Policy": "unsafe-none" }
    : {}),
});

/**
 * @param {URL} requestUrl Incoming request URL.
 * @param {Response} response Response to augment.
 * @param {string} [allowedParentOrigin] Configured Outlook origin.
 */
export const withCrossOriginIsolationHeaders = (
  requestUrl,
  response,
  allowedParentOrigin,
) => {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(
    crossOriginIsolationHeadersForRequest(requestUrl, allowedParentOrigin),
  )) {
    if (!headers.has(name)) {
      headers.set(name, value);
    }
  }
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};
