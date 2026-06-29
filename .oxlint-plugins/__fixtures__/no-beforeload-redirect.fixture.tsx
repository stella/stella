// Passive regression fixture for
// `no-beforeload-redirect/no-beforeload-redirect`.
//
// The disabled lines must be flagged: a route may not redirect from
// beforeLoad/loader. The safe routes below redirect from a mounted component
// (or only guard conditionally), so they must not be flagged.

import { createFileRoute, Navigate, redirect } from "@tanstack/react-router";

const SafeComponent = () => null;
const GuardedComponent = () => null;

// Component-less unconditional redirect: blanks the page on cold loads.
export const BadComponentlessRoute = createFileRoute("/__fixture/bad-alias")({
  // oxlint-disable-next-line no-beforeload-redirect/no-beforeload-redirect
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
});

// Unconditional redirect that also carries a component: the abandoned UI can
// fire queries before mount (#823). Still forbidden.
export const BadComponentRoute = createFileRoute("/__fixture/bad-with-render")({
  // oxlint-disable-next-line no-beforeload-redirect/no-beforeload-redirect
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
  component: SafeComponent,
});

// `loader` returning a redirect is the same alias shape.
export const BadLoaderRoute = createFileRoute("/__fixture/bad-loader")({
  // oxlint-disable-next-line no-beforeload-redirect/no-beforeload-redirect
  loader: () => redirect({ to: "/" }),
});

// Component-less multi-statement dispatcher: still always redirects.
export const BadDispatcherRoute = createFileRoute("/__fixture/bad-dispatch")({
  // oxlint-disable-next-line no-beforeload-redirect/no-beforeload-redirect
  beforeLoad: ({ context }) => {
    if (context.flag) {
      throw redirect({ to: "/a" });
    }
    throw redirect({ to: "/b" });
  },
});

// Safe: redirect from a mounted inert component.
export const SafeRedirectRoute = createFileRoute("/__fixture/safe-redirect")({
  component: () => <Navigate replace to="/" />,
});

// Safe: a conditional guard that protects a route which renders its own page.
export const SafeGuardRoute = createFileRoute("/__fixture/safe-guard")({
  beforeLoad: ({ context }) => {
    if (!context.session) {
      throw redirect({ to: "/auth" });
    }
  },
  component: GuardedComponent,
});
