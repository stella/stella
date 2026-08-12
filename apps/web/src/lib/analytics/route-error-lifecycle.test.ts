import { describe, expect, mock, test } from "bun:test";

import type {
  Analytics,
  RouteErrorLifecycleProperties,
} from "@/lib/analytics/types";

import { createRouteErrorLifecycleController } from "./route-error-lifecycle";
import { createLoadedRouteErrorLifecycleController } from "./route-error-lifecycle-loaded";

const FIRST_REFERENCE = "ERR-DEAD-BEEF-1234" as const;
const SECOND_REFERENCE = "ERR-FEED-FACE-5678" as const;
const ROUTE_TEMPLATE = "/law/$country/cases/$court/$slug";

const setup = () => {
  const errors: { context: unknown; error: unknown }[] = [];
  const events: RouteErrorLifecycleProperties[] = [];
  const analytics = {
    captureError: mock((error, context) => {
      errors.push({ context, error });
    }),
    captureRouteErrorLifecycle: mock((properties) => {
      events.push(properties);
    }),
  } satisfies Pick<Analytics, "captureError" | "captureRouteErrorLifecycle">;

  return {
    analytics,
    controller: createLoadedRouteErrorLifecycleController(analytics, {
      inspectorState: "unavailable",
      routeTemplate: "unknown",
    }),
    errors,
    events,
  };
};

describe("route error lifecycle diagnostics", () => {
  test("preserves call order while rare diagnostics load", async () => {
    const { analytics, events } = setup();
    const controller = createRouteErrorLifecycleController(analytics);
    controller.caught(ROUTE_TEMPLATE);
    controller.shown({
      error: new TypeError("Privileged decision text"),
      recovery: "retry-route",
      reference: FIRST_REFERENCE,
    });
    controller.retryStarted(FIRST_REFERENCE, "retry-route");

    await Bun.sleep(0);

    expect(events.map(({ status }) => status)).toEqual([
      "shown",
      "retry_started",
    ]);
  });

  test("reports an in-app retry", () => {
    const { controller, errors, events } = setup();
    const error = new TypeError("Privileged decision text");
    controller.caught(ROUTE_TEMPLATE);
    controller.shown({
      error,
      recovery: "retry-route",
      reference: FIRST_REFERENCE,
    });

    controller.retryStarted(FIRST_REFERENCE, "retry-route");

    expect(errors).toEqual([
      {
        context: { type: "recovery", reference: FIRST_REFERENCE },
        error,
      },
    ]);
    expect(events.map(({ status }) => status)).toEqual([
      "shown",
      "retry_started",
    ]);
  });

  test("keeps one incident reference when the retry crashes again", () => {
    const { controller, events } = setup();
    const firstError = new TypeError("First privileged payload");
    controller.caught(ROUTE_TEMPLATE);
    controller.shown({
      error: firstError,
      recovery: "retry-route",
      reference: FIRST_REFERENCE,
    });
    controller.retryStarted(FIRST_REFERENCE, "retry-route");

    const secondError = new RangeError("Second privileged payload");
    controller.caught(ROUTE_TEMPLATE);
    controller.shown({
      error: secondError,
      recovery: "retry-route",
      reference: SECOND_REFERENCE,
    });
    expect(events.map(({ status }) => status)).toEqual([
      "shown",
      "retry_started",
      "recurred",
    ]);
    expect(events.at(-1)).toEqual({
      errorFingerprint: expect.stringMatching(/^ERRFP-[0-9A-F]{8}$/u),
      incidentReference: FIRST_REFERENCE,
      inspectorState: "unavailable",
      recovery: "retry-route",
      reference: SECOND_REFERENCE,
      routeTemplate: ROUTE_TEMPLATE,
      status: "recurred",
    });
  });

  test("does not claim that a page reload recovered", () => {
    const { controller, events } = setup();
    const error = new TypeError("Failed to fetch dynamically imported module");
    controller.caught(ROUTE_TEMPLATE);
    controller.shown({
      error,
      recovery: "reload-page",
      reference: FIRST_REFERENCE,
    });

    controller.retryStarted(FIRST_REFERENCE, "reload-page");

    expect(events.map(({ status }) => status)).toEqual([
      "shown",
      "retry_started",
    ]);
  });

  test("deduplicates React strict-effect observation", () => {
    const { controller, errors, events } = setup();
    const error = new TypeError("Privileged decision text");
    controller.caught(ROUTE_TEMPLATE);
    controller.shown({
      error,
      recovery: "retry-route",
      reference: FIRST_REFERENCE,
    });
    controller.shown({
      error,
      recovery: "retry-route",
      reference: FIRST_REFERENCE,
    });
    expect(errors).toHaveLength(1);
    expect(events.map(({ status }) => status)).toEqual(["shown"]);
  });

  test("snapshots inspector visibility for the matching route", () => {
    const { controller, events } = setup();
    controller.routeResolved(ROUTE_TEMPLATE);
    controller.updateInspectorState("open");
    const error = new TypeError("redacted");
    controller.caught(ROUTE_TEMPLATE);
    controller.shown({
      error,
      recovery: "retry-route",
      reference: FIRST_REFERENCE,
    });

    expect(events.at(-1)?.inspectorState).toBe("open");
  });
});
