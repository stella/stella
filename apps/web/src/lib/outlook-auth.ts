import { normalizeRedirectTo } from "@/lib/redirect";

const OUTLOOK_HANDOFF_PATH = "/sign-in-outlook";
const AUTH_PATH = "/auth";
const ORGANIZATION_PATH = "/auth/organization";

export const buildOutlookHandoffPath = (parentOrigin: string): string => {
  const handoff = new URL(OUTLOOK_HANDOFF_PATH, "https://stella.invalid");
  handoff.searchParams.set("parentOrigin", parentOrigin);
  return `${handoff.pathname}${handoff.search}`;
};

export const buildOutlookSignInPath = (parentOrigin: string): string => {
  const signIn = new URL(AUTH_PATH, "https://stella.invalid");
  signIn.searchParams.set("redirectTo", buildOutlookHandoffPath(parentOrigin));
  return `${signIn.pathname}${signIn.search}`;
};

type BuildOutlookSocialCallbackUrlOptions = {
  frontendOrigin: string;
  parentOrigin: string;
};

export const buildOutlookOrganizationSelectionUrl = ({
  frontendOrigin,
  parentOrigin,
}: BuildOutlookSocialCallbackUrlOptions): string => {
  const callback = new URL(ORGANIZATION_PATH, frontendOrigin);
  callback.searchParams.set(
    "redirectTo",
    normalizeRedirectTo(buildOutlookHandoffPath(parentOrigin)),
  );
  return callback.toString();
};

type OutlookSession = {
  activeOrganizationId?: string | null | undefined;
  token?: string | null | undefined;
};

export const outlookSessionHandoff = (
  session: OutlookSession | null | undefined,
): "deliver" | "select-organization" | "signed-out" => {
  if (!session?.token) {
    return "signed-out";
  }
  if (!session.activeOrganizationId) {
    return "select-organization";
  }
  return "deliver";
};

export const surfaceOutlookHandoffFailure = async (
  operation: Promise<void>,
  showError: () => void,
): Promise<void> => {
  await operation.catch((error: unknown) => {
    showError();
    throw error;
  });
};
