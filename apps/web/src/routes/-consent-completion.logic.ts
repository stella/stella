import { isLoopbackRedirectUri } from "@/components/oauth-consent/oauth-destination.logic";
import { queryViewError } from "@/lib/query-view.logic";
import type { QueryView } from "@/lib/query-view.logic";

type ConsentAllowOptions<TSession, TError> = {
  clientInfoLoaded: boolean;
  clientInfoFailed: boolean;
  session: QueryView<TSession, TError>;
};

/**
 * The grant binds to the server's active organization, and the loopback
 * completion carries the organization the page shows. Allow waits for a
 * current session read so both name the same organization.
 */
export const isConsentAllowDisabled = <TSession, TError>({
  clientInfoLoaded,
  clientInfoFailed,
  session,
}: ConsentAllowOptions<TSession, TError>): boolean =>
  clientInfoFailed ||
  !clientInfoLoaded ||
  queryViewError(session) !== undefined;

type ConsentCompletionOptions = {
  accept: boolean;
  redirectUrl: string;
  organizationName: string | null;
};

/** Only the provider's approved redirect determines where completion is shown. */
export const consentCompletion = ({
  accept,
  redirectUrl,
  organizationName,
}: ConsentCompletionOptions):
  | { status: "redirect"; redirectUrl: string }
  | { status: "connected"; redirectUrl: string } => {
  if (!accept) {
    return { status: "redirect", redirectUrl };
  }
  if (isLoopbackRedirectUri(redirectUrl)) {
    const url = new URL(redirectUrl);
    if (organizationName) {
      url.searchParams.set("organization_name", organizationName);
    }
    return { status: "redirect", redirectUrl: url.toString() };
  }
  return { status: "connected", redirectUrl };
};
