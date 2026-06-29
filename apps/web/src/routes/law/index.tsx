import { createFileRoute, redirect } from "@tanstack/react-router";

// /law is a public, server-rendered path (isPublicSsrPath), so the redirect
// must resolve server-side: the loader-time throw becomes a real HTTP redirect
// for crawlers and no-JS clients, instead of a client-only <Navigate> that
// would serve them the empty /law shell. The blank-page race that
// no-beforeload-redirect guards against is specific to the client-only
// _protected subtree, so SSR law routes are exempt from that rule.
export const Route = createFileRoute("/law/")({
  beforeLoad: () => {
    throw redirect({ to: "/law/cases", replace: true });
  },
});
