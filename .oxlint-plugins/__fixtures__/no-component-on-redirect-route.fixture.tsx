// Passive regression fixture for
// `no-component-on-redirect-route/no-component-on-redirect-route`.
//
// The disabled lines must be flagged: an unconditional redirect route should
// not carry render components. The safe routes below keep redirect-only routes
// inert and allow components when redirecting is conditional.

import { createFileRoute, redirect } from "@tanstack/react-router";

const BadComponent = () => null;
const BadPendingComponent = () => null;
const ConditionalComponent = () => null;

export const BadRoute = createFileRoute("/__fixture/bad-redirect")({
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
  // oxlint-disable-next-line no-component-on-redirect-route/no-component-on-redirect-route
  component: BadComponent,
  // oxlint-disable-next-line no-component-on-redirect-route/no-component-on-redirect-route
  pendingComponent: BadPendingComponent,
});

export const RedirectOnlyRoute = createFileRoute("/__fixture/redirect-only")({
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
});

export const ConditionalRedirectRoute = createFileRoute(
  "/__fixture/conditional-redirect",
)({
  beforeLoad: ({ context }) => {
    if (context.shouldRedirect) {
      throw redirect({ to: "/" });
    }
  },
  component: ConditionalComponent,
});
