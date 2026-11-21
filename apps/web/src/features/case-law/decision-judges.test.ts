import { describe, expect, test } from "bun:test";

import { DECISION_JUDGE_ROLES } from "@stll/api-contract/case-law-judges";

import {
  DECISION_JUDGE_ROLE_LABELS,
  decisionBenchSeats,
  dissentingJudges,
  orderDecisionJudges,
  portraitAttributions,
} from "@/features/case-law/decision-judges";
import type { DecisionJudge } from "@/features/case-law/decision-judges";
import { toSafeId } from "@/lib/safe-id";

const judge = (overrides: Partial<DecisionJudge>): DecisionJudge => ({
  judgeId: null,
  name: "Nováková Jana",
  portrait: null,
  role: "rapporteur",
  ...overrides,
});

const portrait = (attribution: string) => ({
  attribution,
  url: "/v1/case/judges/1/portrait",
});

describe("the bench of a decision", () => {
  test("reads rapporteur first, whatever order the read returned", () => {
    const ordered = orderDecisionJudges([
      judge({ name: "Dvořák Petr", role: "dissenting" }),
      judge({ name: "Nováková Jana", role: "rapporteur" }),
    ]);

    expect(ordered.map((entry) => entry.name)).toEqual([
      "Nováková Jana",
      "Dvořák Petr",
    ]);
  });

  test("keeps the printed order of judges who share a role", () => {
    const printed = ["Dvořák Petr", "Benešová Alena", "Marek Tomáš"];
    const ordered = orderDecisionJudges(
      printed.map((name) => judge({ name, role: "dissenting" })),
    );

    expect(ordered.map((entry) => entry.name)).toEqual(printed);
  });

  test("orders without disturbing the array the read handed over", () => {
    const read = [
      judge({ name: "Dvořák Petr", role: "dissenting" }),
      judge({ name: "Nováková Jana", role: "rapporteur" }),
    ];
    orderDecisionJudges(read);

    expect(read.map((entry) => entry.name)).toEqual([
      "Dvořák Petr",
      "Nováková Jana",
    ]);
  });

  test("names every role, so a new one cannot be drawn unlabelled", () => {
    expect(Object.keys(DECISION_JUDGE_ROLE_LABELS).toSorted()).toEqual(
      [...DECISION_JUDGE_ROLES].toSorted(),
    );
  });

  test("draws a judge the roster knows once, captioned with each part they played", () => {
    const svaton = toSafeId<"caseLawJudge">(
      "00000000-0000-4000-8000-000000000001",
    );
    const seats = decisionBenchSeats([
      judge({ name: "Hulmák Milan", role: "panel-member" }),
      judge({
        judgeId: svaton,
        name: "Jan Svatoň",
        portrait: portrait("Ústavní soud"),
        role: "presiding",
      }),
      judge({ judgeId: svaton, name: "Jan Svatoň", role: "rapporteur" }),
    ]);

    expect(seats).toEqual([
      {
        key: `judge:${svaton}`,
        name: "Jan Svatoň",
        portrait: portrait("Ústavní soud"),
        roles: ["rapporteur", "presiding"],
      },
      {
        key: "name:Hulmák Milan",
        name: "Hulmák Milan",
        portrait: null,
        roles: ["panel-member"],
      },
    ]);
  });

  test("a name the roster does not know is one person within a decision, and two names are two", () => {
    const seats = decisionBenchSeats([
      judge({ name: "Nováková Jana", role: "rapporteur" }),
      judge({ name: "Nováková Jana", role: "dissenting" }),
      judge({ name: "Dvořák Petr", role: "dissenting" }),
    ]);

    expect(seats.map(({ name, roles }) => ({ name, roles }))).toEqual([
      { name: "Nováková Jana", roles: ["rapporteur", "dissenting"] },
      { name: "Dvořák Petr", roles: ["dissenting"] },
    ]);
    expect(new Set(seats.map(({ key }) => key)).size).toBe(seats.length);
  });

  test("the byline names only who wrote separately", () => {
    const dissenters = dissentingJudges([
      judge({ name: "Nováková Jana", role: "rapporteur" }),
      judge({ name: "Dvořák Petr", role: "dissenting" }),
    ]);

    expect(dissenters.map((entry) => entry.name)).toEqual(["Dvořák Petr"]);
  });

  test("credits each source once and ignores judges drawn as initials", () => {
    expect(
      portraitAttributions([
        judge({ portrait: portrait("Ústavní soud") }),
        judge({ name: "Dvořák Petr", portrait: portrait("Ústavní soud") }),
        judge({ name: "Marek Tomáš" }),
      ]),
    ).toEqual(["Ústavní soud"]);
    expect(portraitAttributions([judge({})])).toEqual([]);
  });
});
