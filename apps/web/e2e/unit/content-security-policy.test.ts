import { expect, test } from "bun:test";

import { sha256Base64 } from "@stll/sha256/node";

import {
  assertContentSecurityPolicySnapshot,
  renderedInlineScripts,
} from "../helpers/content-security-policy";

const policy =
  "default-src 'self'; script-src 'nonce-document-nonce'; worker-src 'self' blob:";

const nonced = (...nonces: string[]) =>
  nonces.map((nonce) => ({ nonce, text: "window.boot = 1;" }));

test("accepts only enforced documents with a matching rendered script nonce and no violations", () => {
  assertContentSecurityPolicySnapshot({
    policies: [policy],
    scripts: nonced("document-nonce"),
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
        scripts: nonced("document-nonce"),
        violations: [],
      }),
    ).toThrow(/document polic|content-security-policy header/u);
  }
  for (const scripts of [
    nonced("other-nonce"),
    // One correctly nonced script does not excuse an unnonced one.
    nonced("document-nonce", ""),
    nonced("document-nonce", "other-nonce"),
  ]) {
    expect(() =>
      assertContentSecurityPolicySnapshot({
        policies: [policy],
        scripts,
        violations: [],
      }),
    ).toThrow("rendered scripts carry the document policy nonce");
  }
  expect(() =>
    assertContentSecurityPolicySnapshot({
      policies: [policy],
      scripts: [],
      violations: [],
    }),
  ).toThrow("rendered inline scripts captured");
});

test("accepts a shareable document only when every inline script is hashed", () => {
  const boot = "window.boot = 1;";
  const hydrate = "window.hydrate = 1;\r\n";
  const hashed = (...texts: string[]) =>
    `default-src 'self'; script-src 'self' ${texts
      .map((text) => `'sha256-${sha256Base64(text)}'`)
      .join(" ")}; worker-src 'self' blob:`;
  assertContentSecurityPolicySnapshot({
    policies: [hashed(boot, "window.hydrate = 1;\n")],
    scripts: [
      { nonce: "", text: boot },
      { nonce: "", text: hydrate },
    ],
    violations: [],
  });
  for (const scripts of [
    // A script whose hash is not listed is blocked.
    [
      { nonce: "", text: boot },
      { nonce: "", text: "window.injected = 1;" },
    ],
    // A shared document carries no nonce value.
    [{ nonce: "document-nonce", text: boot }],
  ]) {
    expect(() =>
      assertContentSecurityPolicySnapshot({
        policies: [hashed(boot)],
        scripts,
        violations: [],
      }),
    ).toThrow("rendered scripts are admitted by a listed hash");
  }
  expect(() =>
    assertContentSecurityPolicySnapshot({
      policies: ["default-src 'self'; script-src 'self'"],
      scripts: [{ nonce: "", text: boot }],
      violations: [],
    }),
  ).toThrow("document policy script sources");
});

test("rejects a worker policy violation even when the document and nonce are valid", () => {
  expect(() =>
    assertContentSecurityPolicySnapshot({
      policies: [policy],
      scripts: nonced("document-nonce"),
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

test("reads the nonce and text of every parser-inserted inline executable script", () => {
  const html = [
    '<script nonce="document-nonce">window.boot = 1;</script>',
    "<script type=module nonce='document-nonce'>import('/a.js');</script>",
    '<script type="application/json" id="state">{"a":1}</script>',
    '<script src="/assets/entry.js" type="module"></script>',
    '<script data-src="/lazy.js">window.lazy = 1;</script>',
    '<SCRIPT TYPE="text/javascript">window.late = 1;</SCRIPT>',
  ].join("");

  expect(renderedInlineScripts(html)).toEqual([
    { nonce: "document-nonce", text: "window.boot = 1;" },
    { nonce: "document-nonce", text: "import('/a.js');" },
    { nonce: "", text: "window.lazy = 1;" },
    { nonce: "", text: "window.late = 1;" },
  ]);
});
