import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, mock, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import type { Analytics } from "@/lib/analytics/types";

GlobalRegistrator.register({ url: "https://app.example.test/" });
const { Component } = await import("react");
const { act } = await import("@testing-library/react");
const { createRoot } = await import("react-dom/client");
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } =
  await import("@tanstack/react-router");
const { useMountEffect } = await import("@/hooks/use-effect");
const { reportErrorOnce, resetReportedErrorsForTests } =
  await import("@/lib/analytics/reported-error");
const { createRootCaughtErrorHandler } =
  await import("@/lib/analytics/root-caught-error");
const { createRouteCatchHandler, createRouteErrorLifecycleController } =
  await import("@/lib/analytics/route-error-lifecycle");

const REFERENCE = "ERR-DEAD-BEEF-1234" as const;
const ROUTE_TEMPLATE = "/knowledge";

type Captured = { context: unknown; fingerprintKey: string; error: unknown };

const setup = () => {
  const captured: Captured[] = [];
  const analytics = {
    captureError: mock((error, { context, fingerprintKey }) => {
      captured.push({ context, error, fingerprintKey });
    }),
    captureRouteErrorLifecycle: mock(async () => {
      await Promise.resolve();
    }),
  } satisfies Pick<Analytics, "captureError" | "captureRouteErrorLifecycle">;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host, {
    onCaughtError: createRootCaughtErrorHandler(() => analytics),
    // The boundary's rethrow path is not what these tests look at.
    onUncaughtError: () => undefined,
  });
  roots.push(root);
  return { analytics, captured, root };
};

const roots: { unmount: () => void }[] = [];

const noModule = async () => await Promise.withResolvers<never>().promise;

const renderThrowingRoute = async ({
  analytics,
  error,
  panel,
  root,
}: ReturnType<typeof setup> & {
  error: Error;
  panel: (
    lifecycle: ReturnType<typeof createRouteErrorLifecycleController>,
  ) => () => null;
}) => {
  const lifecycle = createRouteErrorLifecycleController(analytics, noModule);
  const router = createRouter({
    defaultErrorComponent: panel(lifecycle),
    defaultOnCatch: createRouteCatchHandler(lifecycle, () => ROUTE_TEMPLATE),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => {
        throw error;
      },
    }),
  });
  await act(async () => {
    await router.load();
    root.render(<RouterProvider router={router} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => {
      root.unmount();
    });
  }
  resetReportedErrorsForTests();
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

test("the route's recovery panel captures the error with its support reference", async () => {
  const context = setup();
  const error = new TypeError("Load failed");

  await renderThrowingRoute({
    ...context,
    error,
    panel: (lifecycle) => {
      const RecoveryPanel = () => {
        useMountEffect(() => {
          lifecycle.shown({
            error,
            recovery: "retry-route",
            reference: REFERENCE,
          });
        });
        return null;
      };
      return RecoveryPanel;
    },
  });

  expect(context.captured).toHaveLength(1);
  expect(context.captured[0]?.error).toBe(error);
  expect(context.captured[0]?.context).toEqual({
    reference: REFERENCE,
    type: "recovery",
  });
  expect(context.captured[0]?.fingerprintKey).not.toBe("hydrate:onCaughtError");
});

test("a network error a route boundary is still retrying stays unreported", async () => {
  const context = setup();

  await renderThrowingRoute({
    ...context,
    error: new TypeError("Failed to fetch"),
    panel: () => () => null,
  });

  expect(context.captured).toHaveLength(0);
});

class SilentBoundary extends Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

class ReportingBoundary extends SilentBoundary {
  override componentDidCatch(error: Error) {
    reportErrorOnce(error, () => {
      reportedByBoundary.push(error);
    });
  }
}

const reportedByBoundary: Error[] = [];

test("the root reports what a silent boundary caught", async () => {
  const { captured, root } = setup();
  const error = new TypeError("Silent boundary");
  const Thrower = () => {
    throw error;
  };

  await act(async () => {
    root.render(
      <SilentBoundary>
        <Thrower />
      </SilentBoundary>,
    );
    await Promise.resolve();
  });

  expect(captured.map((entry) => entry.fingerprintKey)).toEqual([
    "hydrate:onCaughtError",
  ]);
});

test("a boundary that reports from componentDidCatch keeps its own capture", async () => {
  const { captured, root } = setup();
  const error = new TypeError("Reporting boundary");
  const Thrower = () => {
    throw error;
  };

  await act(async () => {
    root.render(
      <ReportingBoundary>
        <Thrower />
      </ReportingBoundary>,
    );
    await Promise.resolve();
  });

  expect(reportedByBoundary).toEqual([error]);
  expect(captured).toHaveLength(0);
});
