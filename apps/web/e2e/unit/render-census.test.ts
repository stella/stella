import { describe, expect, test } from "bun:test";
import { ValiError } from "valibot";

import {
  createRenderRecorder,
  parseRenderCensus,
  summarizeRenderCensus,
} from "../helpers/render-census";
import type { RenderCensus } from "../helpers/render-census";

describe("route render census", () => {
  test("splits the shell painted while requests wait from the data commits", () => {
    expect(
      summarizeRenderCensus({
        roundCommits: [12, 30],
        final: { renderers: 1, commits: 41 },
      }),
    ).toEqual({
      renderers: 1,
      commits: 41,
      dataCommits: 29,
      roundCommits: [12, 30],
    });
  });

  test("a route without API rounds has no data commits", () => {
    expect(
      summarizeRenderCensus({
        roundCommits: [],
        final: { renderers: 1, commits: 7 },
      }).dataCommits,
    ).toBe(0);
  });

  test("rejects samples that run backwards", () => {
    for (const roundCommits of [[12, 11], [50]]) {
      expect(() =>
        summarizeRenderCensus({
          roundCommits,
          final: { renderers: 1, commits: 41 },
        }),
      ).toThrow("Render census went backwards");
    }
  });

  test("samples the census before each round and once at the end", async () => {
    const samples: RenderCensus[] = [
      { renderers: 1, commits: 5 },
      { renderers: 1, commits: 9 },
      { renderers: 1, commits: 14 },
    ];
    const recorder = createRenderRecorder(async () => {
      const next = samples.shift();
      if (next === undefined) {
        throw new Error("census read more often than sampled");
      }
      return next;
    });
    await recorder.beforeRelease();
    await recorder.beforeRelease();
    expect(await recorder.finish()).toEqual({
      renderers: 1,
      commits: 14,
      dataCommits: 9,
      roundCommits: [5, 9],
    });
  });

  test("a page without the hook has no census to read", () => {
    expect(() => parseRenderCensus(null)).toThrow(ValiError);
    expect(() => parseRenderCensus({ renderers: 1, commits: -1 })).toThrow(
      ValiError,
    );
  });
});
