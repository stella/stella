import "bun:test";
import { getReplayTickFixtureRunner } from "@/api/scripts/replay-tick";

type ReplayTickFixtureOptions = Parameters<
  ReturnType<typeof getReplayTickFixtureRunner>
>[1];

/** Fixture configuration is available only through the local-test boundary. */
export const runReplayTickFixture = async (
  signal: AbortSignal,
  fixture: ReplayTickFixtureOptions,
) => await getReplayTickFixtureRunner()(signal, fixture);
