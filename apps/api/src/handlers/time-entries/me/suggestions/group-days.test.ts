import { describe, expect, test } from "bun:test";

import {
  groupSuggestionDays,
  type SuggestionMatterLabel,
} from "@/api/handlers/time-entries/me/suggestions/group-days";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";

const LEASE = createSafeId<"workspace">();
const SERVICES = createSafeId<"workspace">();
const REMOVED = createSafeId<"workspace">();

const labels = new Map<SafeId<"workspace">, SuggestionMatterLabel>([
  [LEASE, { id: LEASE, name: "Nájomná zmluva", reference: "SVAP-1" }],
  [SERVICES, { id: SERVICES, name: "Zmluva o službách", reference: "SVAP-2" }],
]);

const scope = (date: string, workspaceId: SafeId<"workspace">) => ({
  date,
  workspaceId,
  minutes: [30, 12],
});

const group = (scopes: ReturnType<typeof scope>[]) =>
  groupSuggestionDays(
    scopes,
    (workspaceId) => labels.get(workspaceId),
    ({ minutes }) => minutes.map((durationMinutes) => ({ durationMinutes })),
  );

describe("suggestion days", () => {
  test("group each day's matters in order with their active minutes", () => {
    const days = group([
      scope("2026-11-02", LEASE),
      scope("2026-11-02", SERVICES),
      scope("2026-11-03", LEASE),
    ]);
    expect(
      days.map(({ date, matters }) => [
        date,
        matters.map(({ matter, activeMinutes }) => [matter.id, activeMinutes]),
      ]),
    ).toEqual([
      [
        "2026-11-02",
        [
          [LEASE, 42],
          [SERVICES, 42],
        ],
      ],
      ["2026-11-03", [[LEASE, 42]]],
    ]);
  });

  test("leave out a matter deleted after its suggestions loaded, and a day it leaves empty", () => {
    const days = group([
      scope("2026-11-02", REMOVED),
      scope("2026-11-03", LEASE),
      scope("2026-11-03", REMOVED),
      scope("2026-11-03", SERVICES),
    ]);
    expect(
      days.map(({ date, matters }) => [
        date,
        matters.map(({ matter }) => matter.id),
      ]),
    ).toEqual([["2026-11-03", [LEASE, SERVICES]]]);
  });
});
