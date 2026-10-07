import { avtPostgresTestFiles } from "./avt-postgres-tests";
import { runGatedTests } from "./run-gated-tests";

const runnerArguments = Bun.argv.slice(2);
const avtScope = runnerArguments.at(0) === "--avt";

process.exitCode = await runGatedTests({
  requiredEnv: ["DATABASE_URL"],
  script: "test:postgres",
  ...(avtScope
    ? {
        testFiles: await avtPostgresTestFiles(),
        runnerArguments: runnerArguments.slice(1),
      }
    : {}),
});
