import { panic } from "better-result";

/**
 * Which frame the root renders around the matched routes.
 *
 * - `member`: the signed-in app frame (sidebar, inspector, chat providers).
 * - `public`: the shell for visitors without an account.
 * - `checking`: a neutral skeleton while the session is still being read;
 *   neither frame mounts, so nothing fetches.
 * - `none`: the route renders its own shell (sign-in, public law, …) or is
 *   still pending, so the root adds nothing.
 * - `unresolved`: the frame depends on who is visiting; read the session and
 *   ask again with `audience`.
 */
export type AppFrame = "none" | "member" | "public" | "checking" | "unresolved";

/** Who is visiting, as far as the frame is concerned. A member has a
 *  session and an active organization; anyone else is anonymous. */
export type AppFrameAudience = "checking" | "anonymous" | "member";

const PROTECTED_ROUTE_ID = "/_protected";
const KNOWLEDGE_ROUTE_ID = "/knowledge";

type SelectAppFrameInput = {
  /** Ids of the matched routes, root first. */
  routeIds: readonly string[];
  /** Whether a matched route has put the signed-in user in its context. */
  hasRouteUser: boolean;
  /** Whether Knowledge is readable without an account. */
  publicKnowledge: boolean;
  /** Who is visiting; `undefined` until the session has been asked for. */
  audience?: AppFrameAudience | undefined;
};

export const selectAppFrame = ({
  routeIds,
  hasRouteUser,
  publicKnowledge,
  audience,
}: SelectAppFrameInput): AppFrame => {
  const isKnowledge = routeIds.includes(KNOWLEDGE_ROUTE_ID);
  // Routes that sign the visitor in first: the frame waits for the user their
  // guard puts in context, and until then the route shows its own pending
  // shell.
  if (
    routeIds.includes(PROTECTED_ROUTE_ID) ||
    (isKnowledge && !publicKnowledge)
  ) {
    return hasRouteUser ? "member" : "none";
  }
  if (!isKnowledge) {
    return "none";
  }
  // Knowledge for everyone: the frame follows the session, and fails closed
  // while it is unknown.
  switch (audience) {
    case undefined:
      return "unresolved";
    case "checking":
      return "checking";
    case "anonymous":
      return "public";
    case "member":
      return "member";
    default: {
      audience satisfies never;
      return panic(`Unhandled audience: ${String(audience)}`);
    }
  }
};
