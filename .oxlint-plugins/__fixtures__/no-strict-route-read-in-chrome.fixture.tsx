// Passive regression fixture for
// `no-strict-route-read-in-chrome/no-strict-route-read-in-chrome`.

import {
  getRouteApi,
  useMatch,
  useParams,
  useRouteContext,
} from "@tanstack/react-router";

// Route-bound module binding in chrome — MUST flag.
// oxlint-disable-next-line no-strict-route-read-in-chrome/no-strict-route-read-in-chrome
const routeApi = getRouteApi("/_protected");

export function ChromeFixture() {
  // Strict context read — MUST flag. This is the docx-editor crash.
  // oxlint-disable-next-line no-strict-route-read-in-chrome/no-strict-route-read-in-chrome
  const user = useRouteContext({
    from: "/_protected",
    select: (ctx: { user: { id: string } }) => ctx.user.id,
  });

  // Strict match — MUST flag.
  // oxlint-disable-next-line no-strict-route-read-in-chrome/no-strict-route-read-in-chrome
  const match = useMatch({ from: "/_protected" });

  // Opted out via shouldThrow — must NOT flag.
  const safeMatch = useMatch({ from: "/_protected", shouldThrow: false });

  // Opted out via strict — must NOT flag.
  const safeParams = useParams({ strict: false });

  return `${user}${match.id}${safeMatch?.id ?? ""}${String(
    safeParams === undefined,
  )}${routeApi.id}`;
}
