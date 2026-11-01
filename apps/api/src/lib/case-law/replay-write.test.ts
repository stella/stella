import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";

import { caseLawSources } from "@/api/db/schema";

import { replayRawWrite, replayWrite } from "./replay-write";

describe("replay write plans", () => {
  test("a write with no values fails before a self-updating column joins it", () => {
    // `updatedAt` updates itself, so it must not make an empty write look
    // like one with a predicate that can never match.
    expect(() => replayWrite(caseLawSources, {})).toThrow(
      "Replay update has no written columns",
    );
  });

  test("a written value carries the self-updating column with it", () => {
    const plan = replayWrite(caseLawSources, { name: "Replay fixture" });
    expect(Object.keys(plan.set).toSorted()).toEqual(["name", "updatedAt"]);
  });

  test("a reserved session binds scalars and refuses a list it would send as text", async () => {
    const sent: unknown[] = [];
    const session = {
      kind: "session" as const,
      connection: {
        query: async (_query: string, params?: readonly unknown[]) => {
          sent.push(params);
          return await Promise.resolve([]);
        },
      },
    };
    await replayRawWrite({
      table: caseLawSources,
      values: { name: "Replay fixture" },
      predicate: sql`${caseLawSources.adapterKey} = ${"replay"}`,
      operation: { kind: "update" },
    }).execute(session);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("replay");

    const listed = replayRawWrite({
      table: caseLawSources,
      values: { name: "Replay fixture" },
      predicate: sql`${caseLawSources.adapterKey} = ANY(${sql.param(["a", "b"])})`,
      operation: { kind: "update" },
    });
    expect(await rejectionOf(listed.execute(session))).toMatchObject({
      message: "Raw replay session parameters must be scalars",
    });
    expect(sent).toHaveLength(1);
  });
});
