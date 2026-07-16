import {
  isCanaryProvider,
  missingCanaryProviders,
} from "./ai-provider-canary-config";
import type { CanaryProviderSelection } from "./ai-provider-canary-config";

type CanaryCoverageArgs = {
  downloadOutcome: string | undefined;
  selection: CanaryProviderSelection;
};

const flagValue = (args: string[], flag: string): string | undefined => {
  const flagIndex = args.indexOf(flag);
  return flagIndex === -1 ? undefined : args.at(flagIndex + 1);
};

const parseProviderSelection = (args: string[]): CanaryProviderSelection => {
  const value = flagValue(args, "--provider");
  if (value === "all" || (value !== undefined && isCanaryProvider(value))) {
    return value;
  }

  throw new TypeError("Pass --provider followed by all or a canary provider.");
};

export const parseCanaryCoverageArgs = (
  args: string[],
): CanaryCoverageArgs => ({
  downloadOutcome: flagValue(args, "--download-outcome"),
  selection: parseProviderSelection(args),
});

const run = (): void => {
  const { downloadOutcome, selection } = parseCanaryCoverageArgs(
    Bun.argv.slice(2),
  );
  const configuredProviders =
    downloadOutcome === "success"
      ? [...new Bun.Glob("*").scanSync({ cwd: "canary-ran", onlyFiles: true })]
      : [];
  const missingProviders = missingCanaryProviders({
    configuredProviders,
    selection,
  });

  if (missingProviders.length === 0) {
    return;
  }

  console.error(
    `::error title=Missing AI provider canary coverage::Configure canary credentials for: ${missingProviders.join(", ")}.`,
  );
  process.exitCode = 1;
};

if (import.meta.main) {
  run();
}
