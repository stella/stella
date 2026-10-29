import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { expiryInstant } from "./dated-waivers";
import {
  DAY_MS,
  expiredAnnotations,
  expiresAtMs,
  isExpired,
  MAX_QUARANTINE_DAYS,
  parseRegistry,
  quarantineDigest,
  type QuarantineEntry,
  REGISTRY_FILE,
  REPOSITORY_ROOT,
  serializeRegistry,
  splitTestId,
} from "./flaky-test-quarantine";
import { QUARANTINE_ACTION, unownedBunTestSteps } from "./flaky-test-workflow";

const committed = readFileSync(
  path.join(REPOSITORY_ROOT, REGISTRY_FILE),
  "utf-8",
);
const actionSource = readFileSync(
  path.join(
    REPOSITORY_ROOT,
    ".github/actions/flaky-test-quarantine/action.yml",
  ),
  "utf-8",
);

test("the shared action authenticates history reads by default", () => {
  expect(actionSource).toMatch(
    /inputs:\n {2}token:\n(?: {4}.*\n)*? {4}default: \$\{\{ github\.token \}\}/u,
  );
});

const entry = (overrides: Partial<QuarantineEntry> = {}): QuarantineEntry => ({
  id: "apps/web/src/a.test.ts::group > case",
  owner: "octocat",
  reason: "Fails intermittently under load.",
  created: "2026-10-01",
  expires: "2026-10-15",
  ...overrides,
});

const errorsOf = (value: unknown): readonly string[] => {
  const parsed = parseRegistry(value);
  return parsed.status === "invalid" ? parsed.errors : [];
};

describe("committed quarantine registry", () => {
  const parsed = parseRegistry(JSON.parse(committed));

  test("matches the schema and the canonical serialization", () => {
    expect(parsed).toMatchObject({ status: "valid" });
    if (parsed.status === "valid") {
      expect(committed).toBe(serializeRegistry(parsed.registry));
    }
  });

  test("names Bun test files that exist and contain the quarantined test title", () => {
    const entries = parsed.status === "valid" ? parsed.registry.entries : [];
    for (const { id } of entries) {
      const identity = splitTestId(id);
      expect(identity).toBeDefined();
      if (identity === undefined) {
        continue;
      }
      const file = path.join(REPOSITORY_ROOT, identity.file);
      expect(existsSync(file)).toBe(true);
      // A renamed test would leave the entry quarantining nothing.
      const title = identity.name.split(" > ").at(-1) ?? identity.name;
      expect(readFileSync(file, "utf-8")).toContain(title);
    }
  });
});

describe("registry schema", () => {
  test("accepts a complete entry", () => {
    expect(parseRegistry({ entries: [entry()] }).status).toBe("valid");
  });

  test.each([
    ["an unknown field", { ...entry(), retries: 2 }, "retries"],
    ["an owner written as a mention", entry({ owner: "@octocat" }), "owner"],
    ["an empty reason", entry({ reason: "" }), "reason"],
    ["an impossible date", entry({ expires: "2026-02-30" }), "expires"],
    ["an out-of-range month", entry({ expires: "2026-13-01" }), "expires"],
    ["an out-of-range day", entry({ created: "2026-10-99" }), "created"],
    ["a Playwright spec", entry({ id: "apps/web/e2e/a.spec.ts::case" }), "id"],
    ["a Rust test", entry({ id: "apps/desktop/src/lib.rs::case" }), "id"],
    ["an absolute path", entry({ id: "/repo/a.test.ts::case" }), "id"],
    ["a parent path", entry({ id: "../a.test.ts::case" }), "id"],
    [
      "an id without a test name",
      entry({ id: "apps/web/src/a.test.ts" }),
      "id",
    ],
    ["an issue field", { ...entry(), issue: "https://example.com" }, "issue"],
  ])("rejects %s", (_label, value, field) => {
    expect(errorsOf({ entries: [value] }).join("\n")).toContain(field);
  });

  test("rejects an expiry before creation or beyond the maximum span", () => {
    expect(
      errorsOf({
        entries: [entry({ created: "2026-10-02", expires: "2026-10-01" })],
      }),
    ).toEqual([`${entry().id}: expires before it was created`]);
    const limit = new Date(
      Date.parse("2026-10-01T00:00:00Z") + MAX_QUARANTINE_DAYS * DAY_MS,
    )
      .toISOString()
      .slice(0, 10);
    const beyond = new Date(Date.parse(`${limit}T00:00:00Z`) + DAY_MS)
      .toISOString()
      .slice(0, 10);
    expect(errorsOf({ entries: [entry({ expires: limit })] })).toEqual([]);
    expect(errorsOf({ entries: [entry({ expires: beyond })] })).toEqual([
      `${entry().id}: quarantine spans more than ${MAX_QUARANTINE_DAYS} days`,
    ]);
  });

  test("rejects unsorted and duplicate entries", () => {
    const later = entry({ id: "apps/web/src/b.test.ts::case" });
    expect(errorsOf({ entries: [later, entry()] })).toHaveLength(1);
    expect(errorsOf({ entries: [entry(), entry()] })).toHaveLength(1);
    expect(errorsOf({ entries: [entry(), later] })).toEqual([]);
  });
});

describe("quarantine expiry", () => {
  test("admits the whole expiry day in UTC and lapses at its end", () => {
    const value = entry({ expires: "2026-10-15" });
    expect(isExpired(value, new Date("2026-10-15T23:59:59.999Z"))).toBe(false);
    expect(isExpired(value, new Date("2026-10-16T00:00:00.000Z"))).toBe(true);
  });

  test("agrees with the dated-waiver inventory on every day of a leap year", () => {
    for (let day = 0; day < 366; day += 1) {
      const expires = new Date(
        Date.parse("2028-01-01T00:00:00Z") + day * DAY_MS,
      )
        .toISOString()
        .slice(0, 10);
      expect(expiresAtMs({ expires })).toBe(Date.parse(expiryInstant(expires)));
    }
  });

  test("annotates each expired entry at its registry line with its owner", () => {
    const value = entry();
    const content = serializeRegistry({ entries: [value] });
    const [annotation] = expiredAnnotations([value], content);
    expect(annotation).toStartWith(`::error file=${REGISTRY_FILE},line=4,`);
    expect(annotation).toContain("owner: octocat");
  });
});

test("the cache digest changes with the registry", () => {
  const read = (registry: string) => (file: string) =>
    file === REGISTRY_FILE ? registry : "source";
  expect(quarantineDigest(read(committed))).toBe(
    quarantineDigest(read(committed)),
  );
  expect(quarantineDigest(read(committed))).not.toBe(
    quarantineDigest(read(serializeRegistry({ entries: [entry()] }))),
  );
});

describe("workflow quarantine ownership", () => {
  test("every Bun test step is preceded by the shared quarantine action", () => {
    const workflows = path.join(REPOSITORY_ROOT, ".github/workflows");
    const violations = readdirSync(workflows)
      .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
      .flatMap((file) => {
        const workflowPath = `.github/workflows/${file}`;
        const source = readFileSync(
          path.join(REPOSITORY_ROOT, workflowPath),
          "utf-8",
        );
        return unownedBunTestSteps(Bun.YAML.parse(source), workflowPath);
      });

    expect(violations).toEqual([]);
  });

  test("reports a Postgres package test without the shared owner", () => {
    const fixture = {
      jobs: {
        postgres: {
          steps: [
            { uses: "actions/checkout@v4" },
            { run: "bun run test:postgres" },
          ],
        },
      },
    };
    expect(unownedBunTestSteps(fixture, "fixture.yml")).toEqual([
      "fixture.yml: jobs.postgres.steps[1]",
    ]);

    fixture.jobs.postgres.steps.splice(1, 0, { uses: QUARANTINE_ACTION });
    expect(unownedBunTestSteps(fixture, "fixture.yml")).toEqual([]);
  });
});
