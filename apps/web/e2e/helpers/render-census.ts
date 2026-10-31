import type { Page } from "@playwright/test";
import * as v from "valibot";

import { RENDER_CENSUS_GLOBAL } from "./render-census-hook";

const countSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const censusSchema = v.object({
  // React renderers that registered with the hook (react-dom: one).
  renderers: countSchema,
  // Commits of every root since the document started.
  commits: countSchema,
});
export type RenderCensus = v.InferOutput<typeof censusSchema>;

export const parseRenderCensus = (value: unknown): RenderCensus =>
  v.parse(censusSchema, value);

export const readRenderCensus = async (page: Page): Promise<RenderCensus> =>
  parseRenderCensus(
    await page.evaluate((key) => {
      const value: unknown = Reflect.get(globalThis, key);
      return value ?? null;
    }, RENDER_CENSUS_GLOBAL),
  );

export type RouteRenderMetrics = {
  renderers: number;
  // Commits from the document start until the route's network went quiet.
  commits: number;
  // Commits after the first held API round reached the network: the work
  // the route's data causes, as opposed to the shell it paints while waiting.
  dataCommits: number;
  // Commit count observed just before each request round was released.
  roundCommits: number[];
};

export const summarizeRenderCensus = ({
  roundCommits,
  final,
}: {
  roundCommits: readonly number[];
  final: RenderCensus;
}): RouteRenderMetrics => {
  const shellCommits = roundCommits.at(0) ?? final.commits;
  const samples = [...roundCommits, final.commits];
  if (samples.some((commits, index) => commits < (samples[index - 1] ?? 0))) {
    throw new Error(
      `Render census went backwards: rounds ${roundCommits.join(", ")}, final ${String(final.commits)}`,
    );
  }
  return {
    renderers: final.renderers,
    commits: final.commits,
    dataCommits: final.commits - shellCommits,
    roundCommits: [...roundCommits],
  };
};

/**
 * Samples the page's census before each request round is released and once
 * when the route has settled. Pass `beforeRelease` to the network collector's
 * `measureRounds`.
 */
export const createRenderRecorder = (
  read: () => Promise<RenderCensus>,
): {
  beforeRelease: () => Promise<void>;
  finish: () => Promise<RouteRenderMetrics>;
} => {
  const roundCommits: number[] = [];
  return {
    beforeRelease: async () => {
      roundCommits.push((await read()).commits);
    },
    finish: async () =>
      summarizeRenderCensus({ roundCommits, final: await read() }),
  };
};
