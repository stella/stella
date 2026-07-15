import {
  isCanaryProvider,
  missingCanaryProviders,
} from "./ai-provider-canary-config";
import type { CanaryProviderSelection } from "./ai-provider-canary-config";

const parseProviderSelection = (args: string[]): CanaryProviderSelection => {
  const providerFlagIndex = args.indexOf("--provider");
  const value = args.at(providerFlagIndex + 1);
  if (value === "all" || (value !== undefined && isCanaryProvider(value))) {
    return value;
  }

  throw new TypeError("Pass --provider followed by all or a canary provider.");
};

const run = (): void => {
  const args = Bun.argv.slice(2);
  const selection = parseProviderSelection(args);
  const downloadOutcome = args.at(args.indexOf("--download-outcome") + 1);
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
