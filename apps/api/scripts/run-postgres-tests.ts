import {
  assertSharedTableDdlIsolated,
  EXCLUSIVE_SHARED_TABLE_DDL_TEST_PATHS,
} from "./postgres-test-plan";
import { runGatedTests } from "./run-gated-tests";

process.exitCode = await runGatedTests({
  requiredEnv: ["DATABASE_URL"],
  script: "test:postgres",
  selection: process.env["CI_POSTGRES_TEST_SELECTION"],
  exclusiveTestPaths: EXCLUSIVE_SHARED_TABLE_DDL_TEST_PATHS,
  validateTestPlan: assertSharedTableDdlIsolated,
});
