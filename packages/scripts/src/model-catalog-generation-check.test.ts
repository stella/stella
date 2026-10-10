import { describe, expect, test } from "bun:test";

import type { FirstPartyModelProvider } from "@stll/ai-catalog";

import {
  findNewerGenerationModels,
  type GenerationExclusion,
} from "./model-catalog-discovery";
import { checkSnapshotGenerations } from "./model-catalog-generation-check";

const emptyProviderMap = (): Record<FirstPartyModelProvider, string[]> => ({
  anthropic: [],
  google: [],
  mistral: [],
  openai: [],
});

const haikuGuard = (
  upstreamModelId: string,
  exclusion?: GenerationExclusion,
) => {
  const upstreamIds = emptyProviderMap();
  upstreamIds.anthropic.push(upstreamModelId);
  const offered = emptyProviderMap();
  offered.anthropic.push("claude-haiku-5-5");
  return findNewerGenerationModels({
    upstreamIds,
    offered,
    exclusions: new Map(
      exclusion === undefined
        ? []
        : [[`anthropic:${upstreamModelId}` as const, exclusion] as const],
    ),
    asOf: "2026-10-10",
  });
};

describe("model catalog newer-generation guard", () => {
  test("planted newer generation fails", () => {
    expect(haikuGuard("claude-haiku-5-6")).toEqual([
      {
        type: "newer-generation",
        provider: "anthropic",
        modelId: "claude-haiku-5-6",
      },
    ]);
  });

  test("older generations pass", () => {
    expect(haikuGuard("claude-haiku-5-4")).toEqual([]);
  });

  test("floating aliases pass as an explicit non-family class", () => {
    const upstreamIds = emptyProviderMap();
    upstreamIds.google.push("gemini-flash-latest");
    const offered = emptyProviderMap();
    offered.google.push("gemini-3.8-flash");

    expect(
      findNewerGenerationModels({
        upstreamIds,
        offered,
        asOf: "2026-10-10",
      }),
    ).toEqual([]);
  });

  test("a dated, reasoned exclusion passes until expiry", () => {
    expect(
      haikuGuard("claude-haiku-5-6", {
        reviewedOn: "2026-10-01",
        expiresOn: "2026-10-31",
        reason: "Awaiting provider adapter support",
      }),
    ).toEqual([]);
  });

  test("an expired exclusion fails", () => {
    expect(
      haikuGuard("claude-haiku-5-6", {
        reviewedOn: "2026-09-01",
        expiresOn: "2026-09-30",
        reason: "Awaiting provider adapter support",
      }),
    ).toEqual([
      {
        type: "invalid-exclusion",
        provider: "anthropic",
        modelId: "claude-haiku-5-6",
      },
    ]);
  });

  test("an unparseable known-provider id fails closed", () => {
    expect(haikuGuard("claude-haiku-next")).toEqual([
      {
        type: "unparseable",
        provider: "anthropic",
        modelId: "claude-haiku-next",
      },
    ]);
  });
});

describe("snapshot generation check", () => {
  // The newest release in this snapshot predates every review and expiry below.
  const snapshot = {
    anthropic: {
      models: { "claude-haiku-5-6": { release_date: "2026-01-01" } },
    },
    google: { models: {} },
    mistral: { models: {} },
    openai: { models: {} },
  };
  const exclusions = new Map([
    [
      "anthropic:claude-haiku-5-6" as const,
      {
        reviewedOn: "2026-09-01",
        expiresOn: "2026-09-30",
        reason: "Awaiting provider adapter support",
      } as const,
    ],
  ]);

  test("an exclusion reviewed after the newest release is valid until it expires", () => {
    expect(
      checkSnapshotGenerations({ snapshot, today: "2026-09-15", exclusions }),
    ).toEqual([]);
  });

  test("an exclusion expires on the calendar although the snapshot is older", () => {
    expect(
      checkSnapshotGenerations({ snapshot, today: "2026-10-10", exclusions }),
    ).toEqual([
      {
        type: "invalid-exclusion",
        provider: "anthropic",
        modelId: "claude-haiku-5-6",
      },
    ]);
  });
});
