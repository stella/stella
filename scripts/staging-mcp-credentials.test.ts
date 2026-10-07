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
const credentials = new Set<string>();
const journeyCalls = new Set<string>();
const collectCredentials = (node: ts.Node) => {
  if (
    ts.isElementAccessExpression(node) &&
    node.expression.getText(canary) === "process.env" &&
    ts.isStringLiteral(node.argumentExpression) &&
    /(?:EMAIL|PASSWORD|SECRET|TOKEN)$/u.test(node.argumentExpression.text)
  ) {
    credentials.add(node.argumentExpression.text);
  }
  ts.forEachChild(node, collectCredentials);
};
const visit = (node: ts.Node) => {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    /^run\w*Journeys?$/u.test(node.expression.text)
  ) {
    journeyCalls.add(node.expression.text);
    collectCredentials(node);
  }
  ts.forEachChild(node, visit);
};
visit(canary);

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
  expect(env["MCP_CANARY_BASE_URL"]).toBeTruthy();
  expect(
    env["MCP_CANARY_CONFIGURED_BASE_URL"],
    "Review credentials must be bound to the probed staging target",
  ).toBe(env["MCP_CANARY_BASE_URL"]);
  expect(journeyCalls.size).toBeGreaterThan(0);
  expect(credentials.size).toBeGreaterThan(0);
  for (const credential of credentials) {
    expect(
      env[credential],
      `Missing required journey credential: ${credential}`,
    ).toBeTruthy();
  }
};

test("staging requiring complete MCP journeys supplies every credential read by those journeys", () => {
  assertCredentials(staging);
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
    expect(() => assertCredentials(mutant)).toThrow(
      "Review credentials must be bound to the probed staging target",
    );
  }
});
