import { expect, test } from "bun:test";

import { parseBetterAuthBackfillArgs } from "@/api/scripts/better-auth-17-backfill";

test("the Better Auth backfill requires private evidence, a bound, and an explicit write freeze", () => {
  expect(
    parseBetterAuthBackfillArgs([
      "--baseline",
      "/private/baseline.json",
      "--identity-map",
      "/private/identity-map.json",
      "--batch-size",
      "500",
      "--writes-frozen",
    ]),
  ).toMatchObject({
    status: "ok",
    value: {
      baselinePath: "/private/baseline.json",
      batchSize: 500,
      identityMapPath: "/private/identity-map.json",
    },
  });

  for (const args of [
    [],
    [
      "--baseline",
      "baseline",
      "--identity-map",
      "map",
      "--batch-size",
      "0",
      "--writes-frozen",
    ],
    [
      "--baseline",
      "baseline",
      "--identity-map",
      "map",
      "--batch-size",
      "1001",
      "--writes-frozen",
    ],
    ["--baseline", "baseline", "--identity-map", "map", "--batch-size", "500"],
  ]) {
    expect(parseBetterAuthBackfillArgs(args).status).toBe("error");
  }
});
