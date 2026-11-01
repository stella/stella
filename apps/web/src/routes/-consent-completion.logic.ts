import { isLoopbackRedirectUri } from "@/components/oauth-consent/oauth-destination.logic";

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
