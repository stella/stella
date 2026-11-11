import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import messages from "@/i18n/langs/en.json";

import type { RunCarryOver } from "./types";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { cleanup, fireEvent, render, screen, waitFor, within } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { toSafeId } = await import("@/lib/safe-id");
const { RunCarryOverControl } = await import("./run-carry-over");

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
const matchedClaimId = toSafeId<"legalListClaim">(
  "0199a3c4-5b6d-7e8f-9a0b-000000008201",
);

const mount = (carryOver: RunCarryOver) => {
  const opened: string[] = [];
  const shown: string[] = [];
  render(
    <IntlProvider locale="en" messages={messages}>
      <FormattingProvider locale="en" timeZone="UTC">
        <RunCarryOverControl
          carryOver={carryOver}
          onOpenRun={(runId) => opened.push(runId)}
          onShowClaim={(claimId) => shown.push(claimId)}
        />
      </FormattingProvider>
    </IntlProvider>,
  );
  return { opened, shown };
};

const carryOver = (
  carriedCount: number,
  notCarried: RunCarryOver["notCarried"],
): RunCarryOver => ({
  sourceRunId,
  sourceRunCreatedAt: "2026-11-09T09:30:00.000Z",
  carriedCount,
  notCarried,
});

const unmatched = {
  sourceClaimId: sourceClaimId(1),
  text: "The parties met twice in May.",
  outcome: "unmatched",
  targetClaimId: null,
} as const;
const regraded = {
  sourceClaimId: sourceClaimId(2),
  text: "The fee was paid late.",
  outcome: "verdict-changed",
  targetClaimId: matchedClaimId,
} as const;

test("the control counts what came across, and a claim left behind opens in this run", async () => {
  const { opened, shown } = mount(carryOver(12, [unmatched, regraded]));
  const trigger = screen.getByRole("button", {
    name: /^Reviews from the run of Nov 9, 2026\D+9:30\sAM: 12 carried, 2 not carried$/u,
  });
  expect(trigger.textContent).toBe("12 carried · 2 not");
  // The claims left behind stay folded until asked for.
  expect(screen.queryByText("The parties met twice in May.")).toBeNull();
  fireEvent.click(trigger);
  await waitFor(() => {
    expect(screen.getByText("The parties met twice in May.")).toBeTruthy();
  });
  // A claim that matched nothing in this run has nothing to show.
  const unmatchedRow = screen.getByText(
    "The parties met twice in May.",
  ).parentElement;
  expect(unmatchedRow?.closest("button")).toBeNull();
  expect(
    within(unmatchedRow ?? document.body).getByText(
      messages.avt.runs.carryOver.outcomes.unmatched,
    ),
  ).toBeTruthy();
  const regradedRow = screen.getByRole("button", {
    name: /^The fee was paid late\./u,
  });
  expect(
    within(regradedRow).getByText(
      messages.avt.runs.carryOver.outcomes.verdictChanged,
    ),
  ).toBeTruthy();
  fireEvent.click(regradedRow);
  expect(shown).toEqual([matchedClaimId]);
  expect(opened).toEqual([]);
});

test("the footer opens the run the reviews came from", async () => {
  const { opened } = mount(carryOver(3, [regraded]));
  fireEvent.click(screen.getByRole("button", { name: /^Reviews from/u }));
  const open = await waitFor(() =>
    screen.getByRole("button", { name: /^Open the run of Nov 9, 2026/u }),
  );
  fireEvent.click(open);
  expect(opened).toEqual([sourceRunId]);
});

test("a run that carried everything says only how many", () => {
  mount(carryOver(3, []));
  expect(screen.getByRole("button").textContent).toBe("3 carried");
});

test("a run that carried nothing says how many stayed behind", () => {
  mount(carryOver(0, [unmatched]));
  expect(screen.getByRole("button").textContent).toBe("1 not carried");
});
