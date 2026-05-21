import { describe, expect, test } from "bun:test";

import { resolveDatabaseUrl } from "@/api/db-url";

const components = {
  DB_HOST: "db.example",
  DB_PORT: "5432",
  DB_USER: "appuser",
  DB_PASSWORD: "pw",
  DB_NAME: "appdb",
};

describe("resolveDatabaseUrl", () => {
  test("returns DATABASE_URL when present", () => {
    expect(
      resolveDatabaseUrl({ DATABASE_URL: "postgres://x/y", ...components }),
    ).toBe("postgres://x/y");
  });

  test("returns undefined when nothing is set", () => {
    expect(resolveDatabaseUrl({})).toBeUndefined();
  });

  test("assembles URL from components with sslmode=require by default", () => {
    expect(resolveDatabaseUrl(components)).toBe(
      "postgres://appuser:pw@db.example:5432/appdb?sslmode=require",
    );
  });

  test("respects DB_SSLMODE override", () => {
    expect(
      resolveDatabaseUrl({ ...components, DB_SSLMODE: "verify-full" }),
    ).toBe("postgres://appuser:pw@db.example:5432/appdb?sslmode=verify-full");
  });

  test("percent-encodes credentials with reserved characters", () => {
    expect(
      resolveDatabaseUrl({
        ...components,
        DB_USER: "user@host",
        DB_PASSWORD: "p@ss:w/rd?#",
      }),
    ).toBe(
      "postgres://user%40host:p%40ss%3Aw%2Frd%3F%23@db.example:5432/appdb?sslmode=require",
    );
  });

  test("percent-encodes the database name (path segment)", () => {
    expect(
      resolveDatabaseUrl({
        ...components,
        DB_NAME: "appdb?sslmode=disable",
      }),
    ).toBe(
      "postgres://appuser:pw@db.example:5432/appdb%3Fsslmode%3Ddisable?sslmode=require",
    );
  });

  test("preserves bracketed IPv6 host literals", () => {
    expect(resolveDatabaseUrl({ ...components, DB_HOST: "[::1]" })).toBe(
      "postgres://appuser:pw@[::1]:5432/appdb?sslmode=require",
    );
  });

  test("allows empty DB_PASSWORD", () => {
    expect(resolveDatabaseUrl({ ...components, DB_PASSWORD: "" })).toBe(
      "postgres://appuser:@db.example:5432/appdb?sslmode=require",
    );
  });

  test("flags DB_PASSWORD as missing when unset, not when empty", () => {
    expect(() =>
      resolveDatabaseUrl({
        DB_HOST: "db.example",
        DB_PORT: "5432",
        DB_USER: "appuser",
        DB_NAME: "appdb",
      }),
    ).toThrow(/DB_PASSWORD/u);
  });

  test("throws when components are partially set", () => {
    expect(() =>
      resolveDatabaseUrl({ DB_HOST: "db.example", DB_USER: "appuser" }),
    ).toThrow(/incomplete.*DB_PORT.*DB_PASSWORD.*DB_NAME/u);
  });

  test.each([["disable"], ["allow"], ["prefer"], ["bogus"]])(
    "throws on DB_SSLMODE=%s",
    (sslmode) => {
      expect(() =>
        resolveDatabaseUrl({ ...components, DB_SSLMODE: sslmode }),
      ).toThrow(/DB_SSLMODE must be one of/u);
    },
  );

  test.each([["require"], ["verify-ca"], ["verify-full"]])(
    "accepts DB_SSLMODE=%s",
    (sslmode) => {
      expect(resolveDatabaseUrl({ ...components, DB_SSLMODE: sslmode })).toBe(
        `postgres://appuser:pw@db.example:5432/appdb?sslmode=${sslmode}`,
      );
    },
  );

  test.each([
    ["db.example/x"],
    ["db.example?sslmode=disable"],
    ["db.example#frag"],
    ["a@b"],
    ["db .example"],
  ])("throws on DB_HOST containing URL delimiter: %s", (host) => {
    expect(() => resolveDatabaseUrl({ ...components, DB_HOST: host })).toThrow(
      /DB_HOST must not contain URL delimiters/u,
    );
  });

  test.each([["abc"], ["5432a"], ["1 2"], ["-5432"]])(
    "throws on non-numeric DB_PORT=%s",
    (port) => {
      expect(() =>
        resolveDatabaseUrl({ ...components, DB_PORT: port }),
      ).toThrow(/DB_PORT must be numeric/u);
    },
  );
});
