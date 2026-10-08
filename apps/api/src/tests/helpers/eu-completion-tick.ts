import "bun:test";
import { getEuCompletionFixtureRunner } from "@/api/scripts/eu-completion-tick";

type EuCompletionFixtureOptions = Parameters<
  ReturnType<typeof getEuCompletionFixtureRunner>
>[1];

export const runEuCompletionTickFixture = async (
  signal: AbortSignal,
  fixture: EuCompletionFixtureOptions = {},
) => await getEuCompletionFixtureRunner()(signal, fixture);
