// Passive regression fixture for
// `no-beforeload-redirect/no-beforeload-redirect`.
//
// The disabled lines must be flagged: a route may not always-redirect from
// beforeLoad/loader. The safe routes below redirect from a mounted component,
// or guard conditionally with a path that falls through to render.

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
// fire queries before mount (#823). Still forbidden — the rule is
// component-agnostic.
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

// Multi-statement always-redirect WITH a component: the `!hasComponent` proxy
// used to miss this. Every path still ends in a redirect, so it is flagged.
export const BadMultiWithComponentRoute = createFileRoute(
  "/__fixture/bad-multi-render",
)({
  // oxlint-disable-next-line no-beforeload-redirect/no-beforeload-redirect
  beforeLoad: () => {
    const to = "/";
    return redirect({ to });
  },
  component: SafeComponent,
});

// Safe: redirect from a mounted inert component.
export const SafeRedirectRoute = createFileRoute("/__fixture/safe-redirect")({
  component: () => <Navigate replace to="/" />,
});

// Safe: a bare guard that falls through to render when authorized.
export const SafeGuardRoute = createFileRoute("/__fixture/safe-guard")({
  beforeLoad: ({ context }) => {
    if (!context.session) {
      throw redirect({ to: "/auth" });
    }
  },
  component: GuardedComponent,
});

// Safe: a guard with an explicit non-redirect early exit also falls through.
export const SafeEarlyReturnRoute = createFileRoute("/__fixture/safe-early")({
  beforeLoad: ({ context }) => {
    if (context.ok) {
      return;
    }
    throw redirect({ to: "/denied" });
  },
  component: GuardedComponent,
});
