import { describe, expect, test } from "bun:test";

import {
  compareCensus,
  parseDatabaseCensusArgs,
} from "@/api/scripts/database-census";

const census = (
  tables: Record<string, { digest: string | null; rowCount: string }>,
  foreignKeyOrphans: Record<string, string> = {},
) => ({ foreignKeyOrphans, formatVersion: 1 as const, tables });

describe("parseDatabaseCensusArgs", () => {
  test("accepts snapshot and compare with an optional exclusion list", () => {
    const snapshot = parseDatabaseCensusArgs([
      "snapshot",
      "--output",
      "/tmp/census.json",
    ]);
    expect(snapshot.status).toBe("ok");
    if (snapshot.status === "ok") {
      expect(snapshot.value).toEqual({
        exclude: new Set(),
        mode: "snapshot",
        outputPath: "/tmp/census.json",
      });
    }
    const compare = parseDatabaseCensusArgs([
      "compare",
      "--baseline",
      "/tmp/census.json",
      "--exclude",
      "account,oauth_client",
    ]);
    expect(compare.status).toBe("ok");
    if (compare.status === "ok") {
      expect(compare.value).toEqual({
        baselinePath: "/tmp/census.json",
        exclude: new Set(["account", "oauth_client"]),
        mode: "compare",
      });
    }
  });

  test.each([
    [[]],
    [["snapshot"]],
    [["snapshot", "--baseline", "/tmp/x"]],
    [["compare", "--output", "/tmp/x"]],
    [["compare", "--baseline", "/tmp/x", "--exclude"]],
    [["compare", "--baseline", "/tmp/x", "--other", "a"]],
  ])("rejects %j", (args) => {
    expect(parseDatabaseCensusArgs(args).status).toBe("error");
  });
});

describe("compareCensus", () => {
  const baseline = census(
    {
      account: { digest: "a1", rowCount: "11" },
      document: { digest: "d1", rowCount: "5" },
      huge: { digest: null, rowCount: "9000000" },
    },
    { fk_session_user: "0" },
  );

  test("reports no differences for an identical census", () => {
    expect(compareCensus(baseline, baseline, new Set())).toEqual({
      foreignKeyOrphans: [],
      tables: [],
    });
  });

  test("ignores excluded tables and names the metric that changed elsewhere", () => {
    const current = census(
      {
        account: { digest: "a2", rowCount: "11" },
        document: { digest: "d2", rowCount: "5" },
        huge: { digest: null, rowCount: "9000001" },
      },
      { fk_session_user: "0" },
    );
    expect(compareCensus(baseline, current, new Set(["account"]))).toEqual({
      foreignKeyOrphans: [],
      tables: [
        { metric: "digest", table: "document" },
        { metric: "rowCount", table: "huge" },
      ],
    });
  });

  test("reports tables that appeared or vanished and foreign keys with orphans", () => {
    const current = census(
      {
        account: { digest: "a1", rowCount: "11" },
        document: { digest: "d1", rowCount: "5" },
      },
      { fk_session_user: "3" },
    );
    expect(compareCensus(baseline, current, new Set())).toEqual({
      foreignKeyOrphans: ["fk_session_user"],
      tables: [{ metric: "presence", table: "huge" }],
    });
  });
});
