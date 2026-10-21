import type { ComponentProps } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });
const { StrictMode } = await import("react");
const { cleanup, render } = await import("@testing-library/react");
const { AnalyticsProvider } =
  await import("@/lib/analytics/analytics-provider");
const { noopAnalytics } = await import("@/lib/analytics/noop");
const { useProvisionPlacementTelemetry } =
  await import("./use-provision-placement-telemetry");

type TelemetryOptions = Parameters<typeof useProvisionPlacementTelemetry>[0];
type GapEvent = Parameters<
  (typeof noopAnalytics)["captureProvisionPlacementGaps"]
>[0];

const PlacementReports = (options: TelemetryOptions) => {
  useProvisionPlacementTelemetry(options);
  return null;
};

// One reporter is one page load: a fresh analytics client.
const reporter = () => {
  const errors: unknown[] = [];
  const gaps: GapEvent[] = [];
  const value = {
    analytics: {
      ...noopAnalytics,
      captureError: (error: unknown) => {
        errors.push(error);
      },
      captureProvisionPlacementGaps: (event: GapEvent) => {
        gaps.push(event);
      },
    },
    client: null,
  } satisfies ComponentProps<typeof AnalyticsProvider>["value"];
  const tree = (options: TelemetryOptions) => (
    <StrictMode>
      <AnalyticsProvider value={value}>
        <PlacementReports {...options} />
      </AnalyticsProvider>
    </StrictMode>
  );
  const total = () => gaps.reduce((sum, { count }) => sum + count, 0);
  return { errors, gaps, total, tree };
};

afterEach(() => {
  cleanup();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

test("a decision's gaps are one counted event per reason, never an exception", () => {
  const { errors, gaps, tree } = reporter();
  const failures = Array.from({ length: 40 }, (_, index) => ({
    id: `row-${String(index)}`,
    reason: index < 30 ? "work-unresolved" : "span-overlap",
  })) satisfies TelemetryOptions["failures"];

  render(
    tree({ decisionId: "decision-one", surface: "full-reader", failures }),
  );

  expect(errors).toEqual([]);
  expect(gaps).toEqual([
    {
      count: 30,
      kind: "expected",
      reason: "work-unresolved",
      surface: "full-reader",
    },
    {
      count: 10,
      kind: "defect",
      reason: "span-overlap",
      surface: "full-reader",
    },
  ]);
});

test("strict effects, fresh arrays and remounts never count a row twice", () => {
  const { gaps, total, tree } = reporter();
  const options = {
    decisionId: "decision-one",
    surface: "inspector",
    failures: [
      { id: "row-one", reason: "statute-not-loaded" },
      { id: "row-one", reason: "statute-not-loaded" },
    ],
  } as const satisfies TelemetryOptions;

  const view = render(tree(options));
  view.rerender(
    tree({
      ...options,
      failures: options.failures.map((failure) => ({ ...failure })),
    }),
  );
  view.unmount();
  // Reopening the same decision in the same page load.
  for (let mount = 0; mount < 15; mount += 1) {
    render(tree(options)).unmount();
  }

  expect(gaps).toHaveLength(1);
  expect(total()).toBe(1);
});

test("rows that settle later add only themselves", () => {
  const { gaps, tree } = reporter();
  const base = { decisionId: "decision-one", surface: "inspector" } as const;
  const view = render(
    tree({
      ...base,
      failures: [{ id: "row-one", reason: "statute-not-loaded" }],
    }),
  );
  view.rerender(tree({ ...base, failures: [] }));
  view.rerender(
    tree({
      ...base,
      failures: [
        { id: "row-one", reason: "statute-not-loaded" },
        { id: "row-one", reason: "no-version-in-force" },
        { id: "row-two", reason: "statute-not-loaded" },
      ],
    }),
  );

  expect(gaps).toEqual([
    {
      count: 1,
      kind: "expected",
      reason: "statute-not-loaded",
      surface: "inspector",
    },
    {
      count: 1,
      kind: "expected",
      reason: "no-version-in-force",
      surface: "inspector",
    },
    {
      count: 1,
      kind: "expected",
      reason: "statute-not-loaded",
      surface: "inspector",
    },
  ]);
});

test("each decision and surface counts its own rows; a new page load counts again", () => {
  const first = reporter();
  const failure = { id: "row-one", reason: "span-overlap" } as const;
  const view = render(
    first.tree({
      decisionId: "decision-one",
      surface: "full-reader",
      failures: [failure],
    }),
  );
  view.rerender(
    first.tree({
      decisionId: "decision-two",
      surface: "full-reader",
      failures: [failure],
    }),
  );
  view.rerender(
    first.tree({
      decisionId: "decision-two",
      surface: "inspector",
      failures: [failure],
    }),
  );
  expect(first.total()).toBe(3);
  view.unmount();

  const second = reporter();
  render(
    second.tree({
      decisionId: "decision-two",
      surface: "inspector",
      failures: [failure],
    }),
  );
  expect(second.total()).toBe(1);
});
