export type AuthSessionState =
  | "loading"
  | "unavailable"
  | "signedOut"
  | "organizationRequired"
  | "ready";

type SessionResolutionInput = {
  error: unknown;
  isPending: boolean;
  session: unknown;
};

const readActiveOrganizationId = (session: unknown) => {
  if (
    typeof session !== "object" ||
    session === null ||
    !("session" in session)
  ) {
    return null;
  }

  const sessionData = session.session;
  if (typeof sessionData !== "object" || sessionData === null) {
    return null;
  }

  if (!("activeOrganizationId" in sessionData)) {
    return null;
  }
  const activeOrganizationId: unknown = sessionData.activeOrganizationId;
  return typeof activeOrganizationId === "string" &&
    activeOrganizationId.trim().length > 0
    ? activeOrganizationId
    : null;
};

export const resolveAuthSessionState = ({
  error,
  isPending,
  session,
}: SessionResolutionInput): AuthSessionState => {
  if (session !== null && session !== undefined) {
    return readActiveOrganizationId(session) !== null
      ? "ready"
      : "organizationRequired";
  }
  if (isPending) {
    return "loading";
  }
  if (error !== null && error !== undefined) {
    return "unavailable";
  }
  return "signedOut";
};
