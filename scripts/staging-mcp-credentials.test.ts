import { panic } from "better-result";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as v from "valibot";

const canary = ts.createSourceFile(
  "mcp-canary.ts",
  readFileSync(
    new URL("../apps/api/src/scripts/mcp-canary.ts", import.meta.url),
    "utf-8",
  ),
  ts.ScriptTarget.Latest,
  true,
);
const journeyCredentials = (source: ts.SourceFile) => {
  const credentials = new Set<string>();
  const journeyCalls = new Set<string>();
  const isEnvironment = (node: ts.Node) =>
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "process" &&
    node.name.text === "env";
  const environmentRead = (node: ts.Node) => {
    if (
      ts.isElementAccessExpression(node) &&
      isEnvironment(node.expression) &&
      ts.isStringLiteral(node.argumentExpression)
    ) {
      return node.argumentExpression.text;
    }
    if (ts.isPropertyAccessExpression(node) && isEnvironment(node.expression)) {
      return node.name.text;
    }
    return undefined;
  };
  const collect = (node: ts.Node) => {
    const name = environmentRead(node);
    if (name !== undefined) {
      credentials.add(name);
    }
    ts.forEachChild(node, collect);
  };
  const isJourney = (name: string) => /^run\w*Journeys?$/u.test(name);
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      isJourney(node.expression.text)
    ) {
      journeyCalls.add(node.expression.text);
      collect(node);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      isJourney(node.name.text) &&
      node.initializer !== undefined
    ) {
      collect(node.initializer);
    }
    if (
      ts.isFunctionDeclaration(node) &&
      node.name !== undefined &&
      isJourney(node.name.text) &&
      node.body !== undefined
    ) {
      collect(node.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { credentials, journeyCalls };
};
const { credentials, journeyCalls } = journeyCredentials(canary);

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
const assertCredentials = (env: Record<string, string>) => {
  expect(env["MCP_CANARY_REQUIRE_CREDENTIALS"]).toBe("true");
  expect(journeyCalls.size).toBeGreaterThan(0);
  expect(credentials.size).toBeGreaterThan(0);
  for (const credential of credentials) {
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

test("credential derivation covers call arguments and journey bodies with both environment access forms", () => {
  const fixture = ts.createSourceFile(
    "journeys.ts",
    `const runExampleJourney = () => process.env.BODY_PASSWORD;
     function runAnotherJourney() { return process.env["BODY_SECRET"]; }
     runExampleJourney({ email: process.env["CALL_EMAIL"] });
     runAnotherJourney({ token: process.env.CALL_TOKEN });`,
    ts.ScriptTarget.Latest,
    true,
  );
  expect([...journeyCredentials(fixture).credentials].toSorted()).toEqual([
    "BODY_PASSWORD",
    "BODY_SECRET",
    "CALL_EMAIL",
    "CALL_TOKEN",
  ]);
});

test("moving environment reads to dot access or into a journey body preserves the derived requirements", () => {
  const original =
    'runExampleJourney({ password: process.env["REVIEW_ACCOUNT_PASSWORD"] });';
  const derive = (source: string) =>
    [
      ...journeyCredentials(
        ts.createSourceFile(
          "journeys.ts",
          source,
          ts.ScriptTarget.Latest,
          true,
        ),
      ).credentials,
    ].toSorted();
  const expected = derive(original);
  expect(expected).toEqual(["REVIEW_ACCOUNT_PASSWORD"]);
  for (const mutant of [
    original.replace(
      'process.env["REVIEW_ACCOUNT_PASSWORD"]',
      "process.env.REVIEW_ACCOUNT_PASSWORD",
    ),
    'const runExampleJourney = () => process.env["REVIEW_ACCOUNT_PASSWORD"]; runExampleJourney();',
    'function runExampleJourney() { return process.env["REVIEW_ACCOUNT_PASSWORD"]; } runExampleJourney();',
  ]) {
    expect(mutant).not.toBe(original);
    expect(derive(mutant)).toEqual(expected);
  }
});
