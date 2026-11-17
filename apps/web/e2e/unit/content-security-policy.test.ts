import { expect, test } from "bun:test";

import {
  assertContentSecurityPolicySnapshot,
  renderedInlineScriptNonces,
} from "../helpers/content-security-policy";

const policy =
  "default-src 'self'; script-src 'nonce-document-nonce'; worker-src 'self' blob:";

test("accepts only enforced documents with a matching rendered script nonce and no violations", () => {
  assertContentSecurityPolicySnapshot({
    policies: [policy],
    scriptNonces: ["document-nonce"],
    violations: [],
  });
  for (const policies of [
    [],
    [undefined],
    [policy, undefined],
    [undefined, policy],
  ]) {
    expect(() =>
      assertContentSecurityPolicySnapshot({
        policies,
        scriptNonces: ["document-nonce"],
        violations: [],
      }),
    ).toThrow(/document polic|content-security-policy header/u);
  }
  for (const scriptNonces of [
    ["other-nonce"],
    // One correctly nonced script does not excuse an unnonced one.
    ["document-nonce", ""],
    ["document-nonce", "other-nonce"],
  ]) {
    expect(() =>
      assertContentSecurityPolicySnapshot({
        policies: [policy],
        scriptNonces,
        violations: [],
      }),
    ).toThrow("rendered scripts carry the document policy nonce");
  }
  expect(() =>
    assertContentSecurityPolicySnapshot({
      policies: [policy],
      scriptNonces: [],
      violations: [],
    }),
  ).toThrow("rendered inline scripts captured");
});

test("rejects a worker policy violation even when the document and nonce are valid", () => {
  expect(() =>
    assertContentSecurityPolicySnapshot({
      policies: [policy],
      scriptNonces: ["document-nonce"],
      violations: [
        {
          blockedURI: "blob:http://localhost:3000/worker",
          effectiveDirective: "worker-src",
          documentURI: "http://localhost:3000/document",
          sourceFile: "http://localhost:3000/assets/document.js",
          lineNumber: 1,
          columnNumber: 1,
        },
      ],
    }),
  ).toThrow("content security policy violations");
});

test("reads the nonce of every parser-inserted inline executable script", () => {
  const html = [
    '<script nonce="document-nonce">window.boot = 1;</script>',
    "<script type=module nonce='document-nonce'>import('/a.js');</script>",
    '<script type="application/json" id="state">{"a":1}</script>',
    '<script src="/assets/entry.js" type="module"></script>',
    '<script data-src="/lazy.js">window.lazy = 1;</script>',
    '<SCRIPT TYPE="text/javascript">window.late = 1;</SCRIPT>',
  ].join("");

  expect(renderedInlineScriptNonces(html)).toEqual([
    "document-nonce",
    "document-nonce",
    "",
    "",
  ]);
});
