import { runGatedTests } from "./run-gated-tests";

process.exitCode = await runGatedTests({
  requiredEnv: ["DATABASE_URL"],
  script: "test:postgres",
  selection: process.env["CI_POSTGRES_TEST_SELECTION"],
});
