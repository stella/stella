import { panic } from "better-result";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import { MCP_CANARY_JOURNEY_CREDENTIALS } from "../apps/api/src/scripts/mcp-canary-credentials";

type JourneyRequirements = Record<
  string,
  {
    environment: "all" | "staging" | "production";
    env: Record<string, string>;
  }
>;
const requiredFor = (
  environment: string,
  journeys: JourneyRequirements = MCP_CANARY_JOURNEY_CREDENTIALS,
) =>
  Object.values(journeys)
    .filter(
      (journey) =>
        journey.environment === "all" || journey.environment === environment,
    )
    .flatMap(({ env }) => Object.values(env));
const credentials = requiredFor("staging");

const parseWorkflow = (file: string) =>
  v.parse(
    v.looseObject({
      jobs: v.record(
        v.string(),
        v.looseObject({
          steps: v.optional(
            v.array(
              v.looseObject({
                run: v.optional(v.string()),
                env: v.optional(v.record(v.string(), v.string())),
              }),
            ),
          ),
        }),
      ),
    }),
    Bun.YAML.parse(
      readFileSync(
        new URL(`../.github/workflows/${file}`, import.meta.url),
        "utf-8",
      ),
    ),
  );
const canaryEnv = (file: string) =>
  Object.values(parseWorkflow(file).jobs)
    .flatMap(({ steps }) => steps ?? [])
    .find(({ run }) => run === "bun run canary:mcp")?.env ??
  panic(`Missing MCP canary environment: ${file}`);
const staging = canaryEnv("deploy-staging.yml");
const assertCredentials = (
  env: Record<string, string>,
  required = credentials,
) => {
  expect(required.length).toBeGreaterThan(0);
  for (const credential of required) {
    expect(
      env[credential],
      `Missing required journey credential: ${credential}`,
    ).toBeTruthy();
  }
};

const assertTarget = (env: Record<string, string>) => {
  expect(env["MCP_CANARY_BASE_URL"]).toBeTruthy();
  expect(
    env["MCP_CANARY_CONFIGURED_BASE_URL"],
    "Review credentials must be bound to the probed staging target",
  ).toBe(env["MCP_CANARY_BASE_URL"]);
};

test("staging requiring complete MCP journeys supplies every credential read by those journeys", () => {
  expect(credentials).toContain("REVIEW_ACCOUNT_PASSWORD");
  expect(credentials).toContain("APP_REVIEW_ACCOUNT_EMAIL");
  expect(credentials).toContain("MCP_CANARY_CONFIGURED_BASE_URL");
  expect(staging["MCP_CANARY_REQUIRE_CREDENTIALS"]).toBe("true");
  assertCredentials(staging);
  assertTarget(staging);
  expect(staging["APP_REVIEW_ACCOUNT_EMAIL"]).toBe(
    canaryEnv("mcp-canary.yml")["APP_REVIEW_ACCOUNT_EMAIL"],
  );
  expect(staging["REVIEW_ACCOUNT_PASSWORD"]).toBe(
    `\${{ secrets.REVIEW_ACCOUNT_PASSWORD }}`,
  );
});

test("dropping any credential read by a canary journey violates staging's complete-coverage contract", () => {
  for (const credential of credentials) {
    expect(credential in staging).toBe(true);
    const mutant = Object.fromEntries(
      Object.entries(staging).filter(([name]) => name !== credential),
    );
    expect(() => assertCredentials(mutant)).toThrow(
      `Missing required journey credential: ${credential}`,
    );
  }
});

test("an absent or different configured target withholds review credentials and violates staging coverage", () => {
  for (const configured of [undefined, "https://api.stll.app"]) {
    const mutant = { ...staging };
    if (configured === undefined) {
      delete mutant["MCP_CANARY_CONFIGURED_BASE_URL"];
    } else {
      mutant["MCP_CANARY_CONFIGURED_BASE_URL"] = configured;
    }
    expect(mutant).not.toEqual(staging);
    expect(() => assertTarget(mutant)).toThrow(
      "Review credentials must be bound to the probed staging target",
    );
  }
});

test("production also passes every applicable canonical journey input", () => {
  assertCredentials(canaryEnv("mcp-canary.yml"), requiredFor("production"));
});

test("adding a journey requirement without workflow wiring violates complete coverage", () => {
  const added = {
    ...MCP_CANARY_JOURNEY_CREDENTIALS,
    addedJourney: {
      environment: "all",
      env: { password: "ADDED_JOURNEY_PASSWORD" },
    },
  } as const satisfies JourneyRequirements;
  for (const [environment, file] of [
    ["staging", "deploy-staging.yml"],
    ["production", "mcp-canary.yml"],
  ]) {
    if (environment === undefined || file === undefined) {
      panic("Missing workflow fixture");
    }
    expect(requiredFor(environment, added)).toContain("ADDED_JOURNEY_PASSWORD");
    expect(() =>
      assertCredentials(canaryEnv(file), requiredFor(environment, added)),
    ).toThrow("Missing required journey credential: ADDED_JOURNEY_PASSWORD");
  }
});
