import { describe, expect, test } from "bun:test";

import { checkCliPromotion } from "./check-cli-promotion";
import type { GitRunner } from "./promoted-cli-target";

const NOW = 2_000_000_000;
const DAY = 86_400;
const run = async ({
  installedVersion = "6.0.0",
  age = 1,
  previousAge = age,
  previousVersion = "6.0.2",
  missingHistory = false,
  unavailable = false,
}: {
  installedVersion?: string;
  age?: number;
  previousAge?: number;
  previousVersion?: string;
  missingHistory?: boolean;
  unavailable?: boolean;
} = {}) => {
  const gitRunner: GitRunner = (args) => {
    const ref = args.at(1) ?? "";
    if (missingHistory && ref.startsWith("v1.0.0")) {
      return { exitCode: 1, stdout: "" };
    }
    if (args.at(0) !== "show") {
      return { exitCode: 1, stdout: "" };
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        name: "@stll/cli",
        version: ref.startsWith("v2.0.0") ? "6.0.2" : previousVersion,
      }),
    };
  };
  return checkCliPromotion({
    installedVersion,
    now: NOW,
    timeoutMs: 50,
    gitRunner,
    promotionFetch: async () =>
      unavailable
        ? new Response(null, { status: 503 })
        : Response.json([
            {
              tag_name: "v2.0.0",
              draft: false,
              prerelease: false,
              published_at: new Date((NOW - age) * 1000).toISOString(),
            },
            {
              tag_name: "v1.0.0",
              draft: false,
              prerelease: false,
              published_at: new Date(
                (NOW - previousAge - 1) * 1000,
              ).toISOString(),
            },
          ]),
  });
};

describe("installed CLI promotion gate", () => {
  test("skips older installed versions only before the publication deadline", async () => {
    expect(await run({ age: DAY - 1, previousVersion: "6.0.1" })).toEqual({
      status: "skipped",
      reason: "pending_release",
      target: "6.0.2",
      deadline: new Date((NOW + 1) * 1000).toISOString(),
    });
    for (const age of [DAY, DAY + 1]) {
      expect(await run({ age, previousVersion: "6.0.1" })).toMatchObject({
        status: "failed",
        reason: "publish_lagging",
        target: "6.0.2",
      });
    }
  });
  test("accepts installed versions that meet the promoted minimum", async () => {
    for (const installedVersion of ["6.0.2", "6.0.3", "7.0.0"]) {
      expect(await run({ installedVersion, age: DAY + 1 })).toMatchObject({
        status: "passed",
        reason: "ok",
      });
    }
  });
  test("another promotion of the same CLI cannot reset the grace", async () => {
    expect(await run({ age: 1, previousAge: DAY })).toMatchObject({
      status: "failed",
      reason: "publish_lagging",
    });
    expect(
      await run({ age: 1, previousAge: DAY, previousVersion: "6.0.1" }),
    ).toMatchObject({ status: "skipped", reason: "pending_release" });
  });
  test("fails closed on missing history, future promotions and unavailable metadata", async () => {
    expect(await run({ missingHistory: true })).toMatchObject({
      status: "failed",
      reason: "contract_error",
    });
    expect(await run({ age: -1 })).toMatchObject({
      status: "failed",
      reason: "contract_error",
    });
    expect(await run({ unavailable: true })).toMatchObject({
      status: "failed",
      reason: "promotion_unavailable",
    });
    expect(await run({ installedVersion: "garbled" })).toMatchObject({
      status: "failed",
      reason: "contract_error",
    });
  });
});
