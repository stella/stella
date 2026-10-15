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

const PlacementReports = (options: TelemetryOptions) => {
  useProvisionPlacementTelemetry(options);
  return null;
};

const reporter = () => {
  const errors: unknown[] = [];
  const value = {
    analytics: {
      ...noopAnalytics,
      captureError: (error: unknown) => {
        errors.push(error);
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
  return { errors, tree };
};

afterEach(() => {
  cleanup();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

test("placement telemetry reports structured failures once across strict effects and fresh-array rerenders", () => {
  const { errors, tree } = reporter();
  const options = {
    decisionId: "decision-one",
    surface: "full-reader",
    failures: [
      { id: "row-one", reason: "sentence-unlocatable" },
      { id: "row-one", reason: "sentence-unlocatable" },
    ],
  } as const satisfies TelemetryOptions;
  const view = render(tree(options));
  expect(errors).toHaveLength(1);
  expect(errors.at(0)).toMatchObject({
    message:
      "Stored provision placement failed: full-reader/sentence-unlocatable",
    reason: "sentence-unlocatable",
    surface: "full-reader",
  });
  view.rerender(
    tree({
      ...options,
      failures: options.failures.map((failure) => ({ ...failure })),
    }),
  );
  expect(errors).toHaveLength(1);
});

test("recovered placement stops reporting while a later reason and another row remain observable", () => {
  const { errors, tree } = reporter();
  const base = { decisionId: "decision-one", surface: "inspector" } as const;
  const view = render(
    tree({
      ...base,
      failures: [{ id: "row-one", reason: "statute-not-loaded" }],
    }),
  );
  expect(errors).toHaveLength(1);
  view.rerender(tree({ ...base, failures: [] }));
  expect(errors).toHaveLength(1);
  // Recovery cannot make a repeated render of the same mounted incident noisy.
  view.rerender(
    tree({
      ...base,
      failures: [{ id: "row-one", reason: "statute-not-loaded" }],
    }),
  );
  expect(errors).toHaveLength(1);
  view.rerender(
    tree({
      ...base,
      failures: [
        { id: "row-one", reason: "no-version-in-force" },
        { id: "row-two", reason: "statute-not-loaded" },
      ],
    }),
  );
  expect(errors).toHaveLength(3);
  expect(errors.at(1)).toMatchObject({
    reason: "no-version-in-force",
    surface: "inspector",
  });
  expect(errors.at(2)).toMatchObject({
    reason: "statute-not-loaded",
    surface: "inspector",
  });
});

test("decision or surface changes and a fresh mount each report their own placement incident", () => {
  const { errors, tree } = reporter();
  const failure = { id: "row-one", reason: "span-overlap" } as const;
  const view = render(
    tree({
      decisionId: "decision-one",
      surface: "full-reader",
      failures: [failure],
    }),
  );
  expect(errors).toHaveLength(1);
  view.rerender(
    tree({
      decisionId: "decision-two",
      surface: "full-reader",
      failures: [failure],
    }),
  );
  expect(errors).toHaveLength(2);
  view.rerender(
    tree({
      decisionId: "decision-two",
      surface: "inspector",
      failures: [failure],
    }),
  );
  expect(errors).toHaveLength(3);
  expect(errors.at(2)).toMatchObject({
    reason: "span-overlap",
    surface: "inspector",
  });
  view.unmount();
  render(
    tree({
      decisionId: "decision-two",
      surface: "inspector",
      failures: [failure],
    }),
  );
  expect(errors).toHaveLength(4);
});
