import { expect, test } from "bun:test";

import { assertContentSecurityPolicySnapshot } from "../helpers/content-security-policy";

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
  expect(() =>
    assertContentSecurityPolicySnapshot({
      policies: [policy],
      scriptNonces: ["other-nonce"],
      violations: [],
    }),
  ).toThrow("rendered scripts carry the document policy nonce");
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
        },
      ],
    }),
  ).toThrow("content security policy violations");
});
