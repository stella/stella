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
      "--oauth-base-url",
      "https://api.stll.app/",
      "--writes-frozen",
    ]),
  ).toMatchObject({
    status: "ok",
    value: {
      baselinePath: "/private/baseline.json",
      batchSize: 500,
      identityMapPath: "/private/identity-map.json",
      oauthBaseUrl: "https://api.stll.app",
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
      "--oauth-base-url",
      "https://api.stll.app",
      "--writes-frozen",
    ],
    [
      "--baseline",
      "baseline",
      "--identity-map",
      "map",
      "--batch-size",
      "1001",
      "--oauth-base-url",
      "https://api.stll.app",
      "--writes-frozen",
    ],
    ["--baseline", "baseline", "--identity-map", "map", "--batch-size", "500"],
    [
      "--baseline",
      "baseline",
      "--identity-map",
      "map",
      "--batch-size",
      "500",
      "--oauth-base-url",
      "https://api.stll.app/path",
      "--writes-frozen",
    ],
  ]) {
    expect(parseBetterAuthBackfillArgs(args).status).toBe("error");
  }
});
