import { describe, expect, test } from "bun:test";

import { aggregateSkillMonitor } from "./monitor.logic";

describe("aggregateSkillMonitor", () => {
  test("aggregates runs, users, surfaces, daily trend, and context files including unused ones", () => {
    const now = new Date("2026-11-24T15:00:00.000Z");
    const summary = aggregateSkillMonitor({
      now,
      resourcePaths: ["references/a.md", "references/unused.md"],
      rows: [
        {
          createdAt: new Date("2026-11-23T10:00:00.000Z"),
          metadata: { outcome: "success", path: null, surface: "chat" },
          runId: "run-1",
          userId: "user-1",
        },
        {
          createdAt: new Date("2026-11-23T10:00:05.000Z"),
          metadata: {
            outcome: "success",
            path: "references/a.md",
            surface: "chat",
          },
          runId: "run-1",
          userId: "user-1",
        },
        {
          createdAt: new Date("2026-11-24T09:00:00.000Z"),
          metadata: { outcome: "success", path: null, surface: "mcp" },
          runId: null,
          userId: "user-2",
        },
        {
          createdAt: new Date("2026-11-24T09:01:00.000Z"),
          metadata: {
            outcome: "error",
            path: "references/a.md",
            surface: "mcp",
          },
          runId: null,
          userId: "user-2",
        },
      ],
      userProfiles: new Map([
        ["user-1", { image: null, name: "Petra Harbrook" }],
        [
          "user-2",
          { image: "https://example.test/jan.png", name: "Jan Novák" },
        ],
      ]),
      windowDays: 7,
    });

    expect(summary.windowStart).toBe("2026-11-18");
    expect(summary.windowEnd).toBe("2026-11-24");
    expect(summary.dailyTrend).toHaveLength(7);
    expect(summary.totalUses).toBe(2);
    expect(summary.uniqueUsers).toBe(2);
    expect(summary.avgDailyActiveUsers).toBe(0.29);
    expect(summary.instructionsReads).toBe(2);
    expect(summary.contextReads).toBe(2);
    expect(summary.totalReads).toBe(4);
    expect(summary.chatReads).toBe(2);
    expect(summary.mcpReads).toBe(2);
    expect(summary.errorReads).toBe(1);
    expect(summary.contextFiles).toEqual([
      { errors: 1, path: "references/a.md", reads: 2 },
      { errors: 0, path: "references/unused.md", reads: 0 },
    ]);
    expect(summary.activeUsers).toEqual([
      {
        id: "user-2",
        image: "https://example.test/jan.png",
        name: "Jan Novák",
        uses: 1,
      },
      { id: "user-1", image: null, name: "Petra Harbrook", uses: 1 },
    ]);
  });
});
