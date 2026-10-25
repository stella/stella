import { panic } from "better-result";

import { APP_FRAME_SCOPE } from "./-app-frame-scope";
import type { AppFrameScope } from "./-app-frame-scope";

/**
 * Which frame the root renders around the matched routes.
 *
 * - `member`: the signed-in app frame (sidebar, inspector, chat providers).
 * - `public`: the shell for visitors without an account.
 * - `checking`: a neutral skeleton while the session is still being read;
 *   neither frame mounts, so nothing fetches.
 * - `neutral`: the same skeleton around a page that shows the same to every
 *   visitor (a published catalogue entry), so it renders, on the server too,
 *   before the visitor is known.
 * - `none`: the route renders its own shell (sign-in, public law, …), so
 *   the root adds nothing.
 * - `unresolved`: the frame depends on who is visiting; read the session and
 *   ask again with `audience`.
 */
export type AppFrame =
  "none" | "member" | "public" | "checking" | "neutral" | "unresolved";

/** Who is visiting, as far as the frame is concerned. A member has a
 *  session and an active organization; anyone else is anonymous, and a
 *  session that could not be read is `unavailable`. */
export type AppFrameAudience =
  "checking" | "anonymous" | "unavailable" | "member";

// Pages that show the same to every visitor: published catalogue entries.
const VISITOR_INDEPENDENT_ROUTE_IDS: readonly string[] = [
  "/knowledge/templates_/catalogue/$packId/$templateId",
  "/knowledge/tools_/$entry",
  "/knowledge/tools_/contribute",
];

type SelectAppFrameInput = {
  scope: AppFrameScope;
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
  scope,
  routeIds,
  hasRouteUser,
  publicKnowledge,
  audience,
}: SelectAppFrameInput): AppFrame => {
  switch (scope) {
    case APP_FRAME_SCOPE.none:
      return "none";
    case APP_FRAME_SCOPE.member:
      return hasRouteUser ? "member" : "checking";
    case APP_FRAME_SCOPE.knowledge:
      if (!publicKnowledge) {
        return hasRouteUser ? "member" : "checking";
      }
      break;
    default:
      scope satisfies never;
      return panic(`Unhandled frame scope: ${String(scope)}`);
  }
  // Knowledge for everyone: the frame follows the session, and fails closed
  // while it is unknown.
  switch (audience) {
    case undefined:
      return "unresolved";
    case "checking":
      return routeIds.some((id) => VISITOR_INDEPENDENT_ROUTE_IDS.includes(id))
        ? "neutral"
        : "checking";
    // An unreadable session is not a member's: the visitors' shell shows only
    // what is published, and its sign-in is how the session recovers.
    case "anonymous":
    case "unavailable":
      return "public";
    case "member":
      return "member";
    default: {
      audience satisfies never;
      return panic(`Unhandled audience: ${String(audience)}`);
    }
  }
};

/**
 * Who the frame is shown to: a member's user and organization, or an
 * anonymous visitor. `null` while that is unknown, or where the frame does
 * not depend on it.
 */
export const frameVisitor = (
  frame: AppFrame,
  member: { userId: string; organizationId: string } | undefined,
): string | null => {
  switch (frame) {
    case "member":
      return member === undefined
        ? null
        : `member:${member.userId}:${member.organizationId}`;
    case "public":
      return "anonymous";
    case "checking":
    case "neutral":
    case "unresolved":
    case "none":
      return null;
    default: {
      frame satisfies never;
      return panic(`Unhandled frame: ${String(frame)}`);
    }
  }
};

/**
 * Whether the page has moved on to another visitor than the one its frame was
 * last shown to, so what the previous one read must go before the next frame
 * mounts. Only where Knowledge is open to visitors without an account: there
 * one page can outlive a session.
 */
export const visitorChanged = ({
  publicKnowledge,
  shownVisitor,
  visitor,
}: {
  publicKnowledge: boolean;
  shownVisitor: string | null;
  visitor: string | null;
}): boolean =>
  publicKnowledge &&
  visitor !== null &&
  shownVisitor !== null &&
  visitor !== shownVisitor;
