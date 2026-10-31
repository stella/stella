import { expect, test } from "bun:test";

import config from "../../oxlint.config.ts";
import {
  readScopes,
  scopeMatches,
} from "../../scripts/oxlint-config-scopes.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-constructed-fetch-object";
const RULE_ID = `${RULE}/${RULE}`;

const lint = async (source: string) =>
  await lintSingleRule(RULE, source, {
    sourcePath: "apps/mobile/src/connection/http.ts",
  });

/** The severity the production config gives the rule for `file`. */
const severityFor = (file: string): unknown => {
  let severity: unknown;
  for (const scope of readScopes(config)) {
    if (scopeMatches(scope, file) && Object.hasOwn(scope.rules, RULE_ID)) {
      severity = scope.rules[RULE_ID];
    }
  }
  return severity;
};

test("rejects a response rebuilt around a fetch body stream", async () => {
  expect(
    await lint(
      [
        "export const fetchWithTimeout = async (fetch, input, init) => {",
        "  const response = await fetch(input, init);",
        "  const body = response.body;",
        "  return new Response(body, {",
        "    status: response.status,",
        "    statusText: response.statusText,",
        "    headers: response.headers,",
        "  });",
        "};",
      ].join("\n"),
    ),
  ).toEqual([4]);
});

test("rejects Response and Request built from the global classes", async () => {
  expect(
    await lint(
      [
        'new Request("https://example.test", { method: "POST" });',
        "new globalThis.Response(stream);",
        'new globalThis["Request"](url);',
        "new global.Response(null, { status: 204 });",
        "new window.Request(url);",
        "new (Response as typeof globalThis.Response)(text);",
        "Response.json({ ok: true });",
        "globalThis.Response.error();",
        'Response.redirect("https://example.test");',
      ].join("\n"),
    ),
  ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("allows the platform response, plain data and shadowed classes", async () => {
  expect(
    await lint(
      [
        "const response = await fetch(url);",
        "const text = await response.text();",
        "const proxy = new Proxy(response, {});",
        "const payload = { status: response.status, text };",
        "const local = (Response) => new Response(text);",
        "class Request {}",
        "new Request();",
        "Response.prototype.text;",
        "new Headers({ accept: 'application/json' });",
        "new URL(url);",
      ].join("\n"),
    ),
  ).toEqual([]);
});

test("the production config enforces the rule on the mobile app's source only", () => {
  expect(severityFor("apps/mobile/src/connection/http.ts")).toBe("error");
  expect(severityFor("apps/mobile/src/components/matter-row.tsx")).toBe(
    "error",
  );
  expect(
    severityFor("apps/mobile/src/connection/http.test.ts"),
  ).toBeUndefined();
  expect(
    severityFor("apps/mobile/src/connection/test-support/id-token.ts"),
  ).toBeUndefined();
  expect(severityFor("apps/mobile/scripts/sim.ts")).toBeUndefined();
  expect(severityFor("apps/web/src/lib/api.ts")).toBeUndefined();
});
