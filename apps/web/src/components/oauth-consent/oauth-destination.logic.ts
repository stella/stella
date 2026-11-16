import type { OAuthConsentInfo } from "@/lib/oauth-provider";

const isLoopbackHost = (host: string): boolean => {
  const url = URL.parse(`http://${host}`);
  if (!url || url.host !== host || url.username || url.password) {
    return false;
  }
  return (
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/u.test(url.hostname)
  );
};

export const isLoopbackRedirectUri = (redirectUri: string): boolean => {
  const url = URL.parse(redirectUri);
  return Boolean(
    url &&
    (url.protocol === "http:" || url.protocol === "https:") &&
    !url.username &&
    !url.password &&
    isLoopbackHost(url.host),
  );
};

/** Prefer the requested redirect; a client may register both local and hosted destinations. */
export const classifyOAuthDestination = (
  info: OAuthConsentInfo,
  redirectUri: string | null,
): "loopback" | "hosted" => {
  if (redirectUri !== null) {
    return isLoopbackRedirectUri(redirectUri) ? "loopback" : "hosted";
  }
  return info.redirectTargets.length > 0 &&
    info.redirectTargets.every(isLoopbackHost)
    ? "loopback"
    : "hosted";
};
