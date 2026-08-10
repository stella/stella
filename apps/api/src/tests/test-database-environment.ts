import packageJson from "../../package.json" with { type: "json" };

const POSTGRES_TEST_RUNNER = packageJson.ciGateTestRunners["test:postgres"];
export const POSTGRES_TEST_MARKER = POSTGRES_TEST_RUNNER.gate;

const DEFAULT_TEST_DATABASE_URL =
  "postgres://postgres:postgres@localhost:5432/stella";

export const configureTestDatabaseEnvironment = (
  environment: NodeJS.ProcessEnv = process.env,
) => {
  if (environment[POSTGRES_TEST_MARKER] === POSTGRES_TEST_RUNNER.gateValue) {
    return;
  }
  environment["DATABASE_URL"] = DEFAULT_TEST_DATABASE_URL;
};
