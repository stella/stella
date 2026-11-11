import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import messages from "@/i18n/langs/en.json";

import type { RunCarryOver } from "./types";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { toSafeId } = await import("@/lib/safe-id");
const { RunCarryOverNote } = await import("./run-carry-over");

afterEach(() => {
  cleanup();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const sourceRunId = toSafeId<"legalListVerificationRun">(
  "0199a3c4-5b6d-7e8f-9a0b-000000008001",
);
const sourceClaimId = (suffix: number) =>
  toSafeId<"legalListClaim">(
    `0199a3c4-5b6d-7e8f-9a0b-00000000810${String(suffix)}`,
  );

const mount = (carryOver: RunCarryOver) => {
  const opened: string[] = [];
  render(
    <IntlProvider locale="en" messages={messages}>
      <FormattingProvider locale="en" timeZone="UTC">
        <RunCarryOverNote
          carryOver={carryOver}
          onOpenRun={(runId) => opened.push(runId)}
        />
      </FormattingProvider>
    </IntlProvider>,
  );
  return { opened };
};

test("the run header says how many reviews came across and lists the ones that did not", async () => {
  const { opened } = mount({
    sourceRunId,
    sourceRunCreatedAt: "2026-11-09T09:30:00.000Z",
    carriedCount: 12,
    notCarried: [
      {
        sourceClaimId: sourceClaimId(1),
        text: "The parties met twice in May.",
        outcome: "unmatched",
        targetClaimId: null,
      },
      {
        sourceClaimId: sourceClaimId(2),
        text: "The fee was paid late.",
        outcome: "verdict-changed",
        targetClaimId: toSafeId<"legalListClaim">(
          "0199a3c4-5b6d-7e8f-9a0b-000000008201",
        ),
      },
    ],
  });
  expect(
    screen.getByText(
      /^Reviews carried from the run of Nov 9, 2026\D+9:30\sAM: 12$/u,
    ),
  ).toBeTruthy();
  // The claims left behind stay folded until asked for.
  expect(screen.queryByText("The parties met twice in May.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Not carried: 2" }));
  await waitFor(() => {
    expect(screen.getByText("The parties met twice in May.")).toBeTruthy();
  });
  expect(
    screen.getByText(messages.avt.runs.carryOver.outcomes.unmatched),
  ).toBeTruthy();
  expect(screen.getByText("The fee was paid late.")).toBeTruthy();
  expect(
    screen.getByText(messages.avt.runs.carryOver.outcomes.verdictChanged),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: /^Open the run of Nov 9, 2026/u }),
  );
  expect(opened).toEqual([sourceRunId]);
});

test("a run that carried everything says only that", () => {
  mount({
    sourceRunId,
    sourceRunCreatedAt: "2026-11-09T09:30:00.000Z",
    carriedCount: 3,
    notCarried: [],
  });
  expect(screen.getByText(/: 3$/u)).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});
