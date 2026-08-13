import { describe, expect, mock, test } from "bun:test";

import type {
  Analytics,
  RouteErrorLifecycleProperties,
} from "@/lib/analytics/types";

import {
  createRouteErrorLifecycleController,
  resolveCaughtRouteTemplate,
} from "./route-error-lifecycle";
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
      return Promise.resolve();
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
    const { analytics, errors, events } = setup();
    const controller = createRouteErrorLifecycleController(analytics);
    const error = new TypeError("Privileged decision text");
    controller.routeResolved(ROUTE_TEMPLATE);
    controller.updateInspectorState("open");
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
    await controller.retryStarted(FIRST_REFERENCE, "retry-route");

    expect(errors).toEqual([
      {
        context: { reference: FIRST_REFERENCE, type: "recovery" },
        error,
      },
    ]);
    expect(events.map(({ status }) => status)).toEqual([
      "shown",
      "retry_started",
    ]);
    expect(events.at(0)).toMatchObject({
      inspectorState: "open",
      routeTemplate: ROUTE_TEMPLATE,
    });
  });

  test("reads the errored route or attempted leaf at catch time", () => {
    expect(
      resolveCaughtRouteTemplate([
        { fullPath: "/", status: "success" },
        { fullPath: "/law/$country", status: "error" },
        { fullPath: ROUTE_TEMPLATE, status: "pending" },
      ]),
    ).toBe("/law/$country");
    expect(
      resolveCaughtRouteTemplate([
        { fullPath: "/", status: "success" },
        { fullPath: ROUTE_TEMPLATE, status: "pending" },
      ]),
    ).toBe(ROUTE_TEMPLATE);
    expect(resolveCaughtRouteTemplate([])).toBe("unknown");
  });

  test("reports an in-app retry", async () => {
    const { controller, events } = setup();
    const error = new TypeError("Privileged decision text");
    controller.caught(ROUTE_TEMPLATE);
    controller.shown({
      error,
      recovery: "retry-route",
      reference: FIRST_REFERENCE,
    });

    await controller.retryStarted(FIRST_REFERENCE, "retry-route");

    expect(events.map(({ status }) => status)).toEqual([
      "shown",
      "retry_started",
    ]);
  });

  test("keeps one incident reference when the retry crashes again", async () => {
    const { controller, events } = setup();
    const firstError = new TypeError("First privileged payload");
    controller.caught(ROUTE_TEMPLATE);
    controller.shown({
      error: firstError,
      recovery: "retry-route",
      reference: FIRST_REFERENCE,
    });
    await controller.retryStarted(FIRST_REFERENCE, "retry-route");

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

  test("does not claim that a page reload recovered", async () => {
    const { controller, events } = setup();
    const error = new TypeError("Failed to fetch dynamically imported module");
    controller.caught(ROUTE_TEMPLATE);
    controller.shown({
      error,
      recovery: "reload-page",
      reference: FIRST_REFERENCE,
    });

    await controller.retryStarted(FIRST_REFERENCE, "reload-page");

    expect(events.map(({ status }) => status)).toEqual([
      "shown",
      "retry_started",
    ]);
  });

  test("deduplicates React strict-effect observation", () => {
    const { controller, events } = setup();
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
    expect(events.map(({ status }) => status)).toEqual(["shown"]);
  });

  test("snapshots inspector visibility for the matching route", () => {
    const { controller, events } = setup();
    controller.routeResolved(ROUTE_TEMPLATE);
    controller.updateInspectorState("open");
    const error = new TypeError("redacted");
    controller.caught(ROUTE_TEMPLATE);
    controller.updateInspectorState("unavailable");
    controller.shown({
      error,
      recovery: "retry-route",
      reference: FIRST_REFERENCE,
    });

    expect(events.at(-1)?.inspectorState).toBe("open");
  });
});
