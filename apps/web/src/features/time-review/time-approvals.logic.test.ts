import { describe, expect, test } from "bun:test";

import { cents } from "@stll/money";

import {
  groupForReview,
  type ReviewRowWithPerson,
} from "./time-approvals.logic";

const row = (
  id: string,
  overrides: Partial<ReviewRowWithPerson> = {},
): ReviewRowWithPerson => ({
  id,
  workspaceId: "matter-1",
  timekeeperId: "user-b",
  timekeeperName: "Beata",
  matterName: "Harbour lease",
  dateWorked: "2026-10-27",
  durationMinutes: 60,
  billedMinutes: 60,
  rateAtEntry: cents(120_000),
  currency: "CZK",
  billable: true,
  noCharge: false,
  narrative: `Work ${id}`,
  returnComment: null,
  ...overrides,
});

describe("grouping time for review", () => {
  test("groups by person in name order, then by work date, keeping every row once", () => {
    const rows = [
      row("b-tue", { dateWorked: "2026-10-27" }),
      row("a-mon", {
        timekeeperId: "user-a",
        timekeeperName: "Adam",
        dateWorked: "2026-10-26",
      }),
      row("b-mon", { dateWorked: "2026-10-26" }),
      row("b-tue-2", { dateWorked: "2026-10-27" }),
    ];
    const grouped = groupForReview(rows, "en");
    expect(grouped.map((person) => person.timekeeperName)).toEqual([
      "Adam",
      "Beata",
    ]);
    expect(
      grouped[1]?.days.map((day) => [day.date, day.rows.map(({ id }) => id)]),
    ).toEqual([
      ["2026-10-26", ["b-mon"]],
      ["2026-10-27", ["b-tue", "b-tue-2"]],
    ]);
    const regrouped = grouped.flatMap((person) =>
      person.days.flatMap((day) => day.rows.map(({ id }) => id)),
    );
    expect(regrouped.toSorted()).toEqual(rows.map(({ id }) => id).toSorted());
  });

  test("totals billed time per person and amounts per currency, leaving unpriced, no-charge and non-billable time out of the amount", () => {
    const [person] = groupForReview(
      [
        row("priced", { billedMinutes: 90 }),
        row("unpriced", {
          billedMinutes: 30,
          currency: "XXX",
          rateAtEntry: cents(0),
        }),
        row("free", { billedMinutes: 60, noCharge: true }),
        // Non-billable work keeps its rate but never reaches an invoice.
        row("internal", { billedMinutes: 45, billable: false }),
        row("euro", { currency: "EUR", rateAtEntry: cents(20_000) }),
      ],
      "en",
    );
    expect(person?.billedMinutes).toBe(285);
    expect(person?.amounts).toEqual([
      { currency: "CZK", amount: 180_000 },
      { currency: "EUR", amount: 20_000 },
    ]);
  });
});
