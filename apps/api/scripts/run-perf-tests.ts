import { runGatedTests } from "./run-gated-tests";

process.exitCode = await runGatedTests({
  requiredEnv: ["DATABASE_URL"],
  script: "test:perf",
});
