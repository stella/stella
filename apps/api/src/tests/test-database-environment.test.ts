import { describe, expect, test } from "bun:test";

import {
  configureTestDatabaseEnvironment,
  POSTGRES_TEST_MARKER,
} from "./test-database-environment";

describe("test database environment", () => {
  test("replaces ambient credentials for hermetic tests", () => {
    const environment = {
      DATABASE_URL: "postgres://stella:password@localhost:5432/stella",
    };

    configureTestDatabaseEnvironment(environment);

    expect(environment.DATABASE_URL).toBe(
      "postgres://postgres:postgres@localhost:5432/stella",
    );
  });

  test("preserves the explicit Postgres test database", () => {
    const environment = {
      DATABASE_URL: "postgres://integration:password@db.example/stella",
      [POSTGRES_TEST_MARKER]: "true",
    };

    configureTestDatabaseEnvironment(environment);

    expect(environment.DATABASE_URL).toBe(
      "postgres://integration:password@db.example/stella",
    );
  });
});
