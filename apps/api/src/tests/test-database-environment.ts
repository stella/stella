export const POSTGRES_TEST_MARKER = "STELLA_RUN_POSTGRES_TESTS";

const DEFAULT_TEST_DATABASE_URL =
  "postgres://postgres:postgres@localhost:5432/stella";

export const configureTestDatabaseEnvironment = (
  environment: NodeJS.ProcessEnv = process.env,
) => {
  if (environment[POSTGRES_TEST_MARKER] === "true") {
    return;
  }
  environment["DATABASE_URL"] = DEFAULT_TEST_DATABASE_URL;
};
