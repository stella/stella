export type AuthSessionState =
  | { type: "loading" }
  | { type: "unavailable" }
  | { type: "signedOut" }
  | { type: "organizationRequired" }
  | { activeOrganizationId: string; type: "ready" };

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
    const activeOrganizationId = readActiveOrganizationId(session);
    if (activeOrganizationId === null) {
      return { type: "organizationRequired" };
    }
    return { activeOrganizationId, type: "ready" };
  }
  if (isPending) {
    return { type: "loading" };
  }
  if (error !== null && error !== undefined) {
    return { type: "unavailable" };
  }
  return { type: "signedOut" };
};
