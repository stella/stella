import { describe, expect, it } from "bun:test";

import { applyMattersFilters, parseLocalISODateMs } from "./filter-pipeline";

const workspace = ({
  id,
  createdAt,
  leadUserId = null,
  members = [],
}: {
  id: string;
  createdAt: Date;
  leadUserId?: string | null;
  members?: { userId: string }[];
}) => ({
  client: null,
  createdAt,
  entityCount: 0,
  id,
  lastActivityAt: createdAt,
  leadUserId,
  members,
});

describe("matter filters", () => {
  it("parses custom date filter values as local calendar dates", () => {
    const parsed = new Date(parseLocalISODateMs("2026-06-03"));

    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(5);
    expect(parsed.getDate()).toBe(3);
    expect(parsed.getHours()).toBe(0);
  });

  it("applies custom date filters inclusively by selected local dates", () => {
    const results = applyMattersFilters(
      [
        workspace({
          id: "before",
          createdAt: new Date(2026, 5, 2, 23, 59, 59, 999),
        }),
        workspace({
          id: "inside",
          createdAt: new Date(2026, 5, 3, 12),
        }),
        workspace({
          id: "after",
          createdAt: new Date(2026, 5, 4),
        }),
      ],
      {
        createdAt: {
          preset: "custom",
          from: "2026-06-03",
          to: "2026-06-03",
        },
      },
      new Date("2026-06-10T12:00:00.000"),
    );

    expect(results.map((result) => result.id)).toEqual(["inside"]);
  });

  it("matches lead and team filters independently", () => {
    const results = applyMattersFilters(
      [
        workspace({
          id: "lead-and-member",
          leadUserId: "user_1",
          createdAt: new Date(2026, 5, 3, 12),
          members: [{ userId: "user_2" }],
        }),
        workspace({
          id: "member-only",
          leadUserId: null,
          createdAt: new Date(2026, 5, 3, 12),
          members: [{ userId: "user_2" }],
        }),
      ],
      {
        lead: { type: "user", userId: "user_1" },
        team: ["user_2"],
      },
      new Date("2026-06-10T12:00:00.000"),
    );

    expect(results.map((result) => result.id)).toEqual(["lead-and-member"]);
  });
});
