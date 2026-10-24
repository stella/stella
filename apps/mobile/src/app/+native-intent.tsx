import { isSignInRedirect } from "@/connection/redirect";

/**
 * Leaves the sign-in redirect to the browser session waiting for it, so the
 * router stays on the sign-in screen instead of showing an unmatched route.
 */
export const redirectSystemPath = ({
  path,
}: {
  path: string;
  initial: boolean;
}): string | null => (isSignInRedirect(path) ? null : path);
