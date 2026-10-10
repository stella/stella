import { fileURLToPath } from "node:url";

import {
  LEGAL_AST_CAPABILITIES,
  getRunnerDefinition,
  getRunnerDefinitions,
  isRunnerName,
} from "@stll/legal-atlas";
import { childExitStatus } from "@stll/scripts/src/child-exit-status";

const HELP = `Usage:
  legal-atlas list
  legal-atlas run <runner>
  legal-atlas smoke

Reserved runners:
${getRunnerDefinitions()
  .map((runner) => `  ${runner.name}  ${runner.description}`)
  .join("\n")}
`;

const writeOut = async (text: string): Promise<number> =>
  await Bun.write(Bun.stdout, `${text}\n`);

const writeErr = async (text: string): Promise<number> =>
  await Bun.write(Bun.stderr, `${text}\n`);

type RunCliOptions = {
  refetch?: (argv: readonly string[]) => Promise<number>;
};

const refetchEuDecisions = async (argv: readonly string[]): Promise<number> => {
  const entrypoint = new URL(
    import.meta.path.endsWith(".ts")
      ? "../../api/src/scripts/eu-ecj-refetch.ts"
      : "./eu-ecj-refetch.js",
    import.meta.url,
  );
  const child = Bun.spawn(
    [process.execPath, fileURLToPath(entrypoint), ...argv],
    {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const interrupt = () => child.kill("SIGINT");
  const terminate = () => child.kill("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    await child.exited;
    return childExitStatus(child);
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
};

type ImplementedRunnerOptions = {
  runnerName: string;
  argv: readonly string[];
  refetch: (argv: readonly string[]) => Promise<number>;
};
const runImplementedRunner = async ({
  runnerName,
  argv,
  refetch,
}: ImplementedRunnerOptions): Promise<number> => {
  if (runnerName === "eu-ecj-refetch") {
    return await refetch(argv);
  }

  if (runnerName === "case-law-ingest") {
    const { runCaseLawIngest } = await import("./runners/case-law-ingest.js");
    return await runCaseLawIngest(argv);
  }

  if (runnerName === "case-law-corpus-storage-backfill") {
    const { runCaseLawCorpusStorageBackfill } =
      await import("./runners/case-law-corpus-storage-backfill.js");
    return await runCaseLawCorpusStorageBackfill(argv);
  }

  if (runnerName === "legal-corpus-storage-backfill") {
    const { runLegalCorpusStorageBackfill } =
      await import("./runners/case-law-corpus-storage-backfill.js");
    return await runLegalCorpusStorageBackfill(argv);
  }

  await writeErr(`Runner ${runnerName} is registered without an entrypoint.`);
  return 70;
};

export const runCli = async (
  argv: readonly string[],
  { refetch = refetchEuDecisions }: RunCliOptions = {},
): Promise<number> => {
  const command = argv.at(0) ?? "--help";

  if (command === "--help" || command === "-h") {
    await writeOut(HELP);
    return 0;
  }

  if (command === "list") {
    await writeOut(
      getRunnerDefinitions()
        .map(
          (runner) => `${runner.name}\t${runner.status}\t${runner.description}`,
        )
        .join("\n"),
    );
    return 0;
  }

  if (command === "smoke") {
    const runners = getRunnerDefinitions();
    if (runners.length === 0) {
      await writeErr("No legal-atlas runners are registered.");
      return 1;
    }
    if (!LEGAL_AST_CAPABILITIES.supportsConsolidatedStatus) {
      await writeErr("Statute AST status guard is not available.");
      return 1;
    }
    await writeOut(`legal-atlas smoke ok (${runners.length} runner slots)`);
    return 0;
  }

  if (command !== "run") {
    await writeErr(`Unknown command: ${command}`);
    await writeErr(HELP);
    return 64;
  }

  const runnerName = argv.at(1);
  if (!isRunnerName(runnerName)) {
    await writeErr(`Unknown runner: ${runnerName ?? "(missing)"}`);
    return 64;
  }

  const runner = getRunnerDefinition(runnerName);
  if (runner.status !== "implemented") {
    await writeErr(
      `Runner ${runner.name} is reserved but not implemented yet: ${runner.description}`,
    );
    return 78;
  }

  return await runImplementedRunner({
    runnerName: runner.name,
    argv: argv.slice(2),
    refetch,
  });
};

if (import.meta.main) {
  const exitCode = await runCli(Bun.argv.slice(2));
  process.exit(exitCode);
}
