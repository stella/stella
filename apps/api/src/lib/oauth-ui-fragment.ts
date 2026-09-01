import {
  OAUTH_UI_CONSENT_PATH,
  OAUTH_UI_LOGIN_PATH,
  OAUTH_UI_ORGANIZATION_PATH,
} from "@/api/lib/auth-paths";

const OAUTH_SIGNATURE_PARAM = "sig";
const OAUTH_QUERY_HASH_PARAM = "oauth_query";

const OAUTH_UI_FRONTEND_PATHS = {
  [OAUTH_UI_CONSENT_PATH]: "/consent",
  [OAUTH_UI_LOGIN_PATH]: "/auth",
  [OAUTH_UI_ORGANIZATION_PATH]: "/auth/organization",
} as const satisfies Record<
  | typeof OAUTH_UI_CONSENT_PATH
  | typeof OAUTH_UI_LOGIN_PATH
  | typeof OAUTH_UI_ORGANIZATION_PATH,
  string
>;

type BridgeOauthUiRedirectOptions = {
  authOrigin: string;
  frontendUrl: string;
  location: string;
};

const isOauthUiPath = (
  path: string,
): path is keyof typeof OAUTH_UI_FRONTEND_PATHS =>
  Object.hasOwn(OAUTH_UI_FRONTEND_PATHS, path);

/**
 * Moves Better Auth's signed interaction query into a browser fragment.
 *
 * The signed value contains the OAuth client's loopback redirect URI. Keeping
 * it in a query makes CDNs and WAFs inspect (and commonly block) the navigation
 * before Stella can render the login page. Fragments never cross the network;
 * the web client returns the unchanged signed query in `oauth_query` when it
 * continues the flow, so signature verification remains the trust boundary.
 */
export const bridgeOauthUiRedirect = ({
  authOrigin,
  frontendUrl,
  location,
}: BridgeOauthUiRedirectOptions): string | null => {
  const trustedAuthOrigin = new URL(authOrigin).origin;
  const source = new URL(location, `${trustedAuthOrigin}/`);

  if (
    source.origin !== trustedAuthOrigin ||
    !isOauthUiPath(source.pathname) ||
    !source.searchParams.has(OAUTH_SIGNATURE_PARAM)
  ) {
    return null;
  }

  const redirect = new URL(
    OAUTH_UI_FRONTEND_PATHS[source.pathname],
    `${frontendUrl.replace(/\/$/u, "")}/`,
  );
  const fragment = new URLSearchParams();
  fragment.set(OAUTH_QUERY_HASH_PARAM, source.search.slice(1));
  redirect.hash = fragment.toString();
  return redirect.toString();
};

type OauthUiInteraction = {
  responseHeaders?: Headers | undefined;
  returned?: unknown;
};

const isJsonRedirect = (
  value: unknown,
): value is { redirect: true; url: string } =>
  typeof value === "object" &&
  value !== null &&
  "redirect" in value &&
  value.redirect === true &&
  "url" in value &&
  typeof value.url === "string";

/** Rewrites both browser 302s and Better Auth's fetch-mode redirect object. */
export const bridgeOauthUiInteraction = (
  interaction: OauthUiInteraction,
  options: Omit<BridgeOauthUiRedirectOptions, "location">,
): void => {
  if (isJsonRedirect(interaction.returned)) {
    const url = bridgeOauthUiRedirect({
      ...options,
      location: interaction.returned.url,
    });
    if (url) {
      interaction.returned = { redirect: true, url };
    }
    return;
  }

  const location = interaction.responseHeaders?.get("location");
  if (!location) {
    return;
  }

  const bridged = bridgeOauthUiRedirect({ ...options, location });
  if (bridged) {
    interaction.responseHeaders?.set("location", bridged);
  }
};
