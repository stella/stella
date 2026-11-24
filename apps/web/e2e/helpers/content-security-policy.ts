// The E2E configuration is node-only; the init script runs in the browser.
/// <reference lib="dom" />
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { sha256Base64 } from "@stll/sha256/node";

type ContentSecurityPolicyViolation = {
  blockedURI: string;
  effectiveDirective: string;
  documentURI: string;
  // Where the blocked load or evaluation came from, so a failure names the
  // offending script instead of only the page it ran on.
  sourceFile: string;
  lineNumber: number;
  columnNumber: number;
};

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- global Window augmentation requires interface declaration merging
  interface Window {
    __pendingContentSecurityPolicyViolations: Promise<void>[];
    __recordContentSecurityPolicyViolation: (
      violation: ContentSecurityPolicyViolation,
    ) => Promise<void>;
  }
}

type RenderedInlineScript = { nonce: string; text: string };

type ContentSecurityPolicySnapshot = {
  violations: readonly ContentSecurityPolicyViolation[];
  policies: readonly (string | undefined)[];
  scripts: readonly RenderedInlineScript[];
};

/**
 * A private document admits its inline scripts by a per-response nonce. A
 * document a shared cache may store names no nonce: it lists the SHA-256 of
 * each inline script instead, and its markup carries no nonce.
 */
export const assertContentSecurityPolicySnapshot = ({
  violations,
  policies,
  scripts,
}: ContentSecurityPolicySnapshot) => {
  expect(violations, "content security policy violations").toEqual([]);
  expect(
    policies.length,
    "enforced document policies captured",
  ).toBeGreaterThan(0);
  for (const policy of policies) {
    expect(policy, "document content-security-policy header").toBeTruthy();
    expect(policy, "document policy script sources").toMatch(
      /'(?:nonce|sha256)-[^']+'/u,
    );
  }
  expect(scripts.length, "rendered inline scripts captured").toBeGreaterThan(0);
  const policy = policies.at(-1) ?? "";
  const nonce = /'nonce-([^']+)'/u.exec(policy)?.[1];
  if (nonce !== undefined) {
    // Every inline script, not just one: a single unnonced script among
    // nonced ones is still blocked by the policy.
    expect(
      scripts.filter((script) => script.nonce !== nonce),
      "rendered scripts carry the document policy nonce",
    ).toEqual([]);
    return;
  }
  const hashes = new Set(
    [...policy.matchAll(/'sha256-([^']+)'/gu)].map((match) => match[1]),
  );
  expect(
    scripts.filter(
      (script) =>
        script.nonce !== "" ||
        !hashes.has(sha256Base64(script.text.replaceAll(/\r\n?/gu, "\n"))),
    ),
    "rendered scripts are admitted by a listed hash and carry no nonce",
  ).toEqual([]);
};

// Inline scripts the policy evaluates; data blocks (JSON) never execute and
// external scripts are admitted by source, so neither carries the nonce.
const EXECUTABLE_SCRIPT_TYPES = new Set([
  "",
  "module",
  "text/javascript",
  "application/javascript",
]);
const SCRIPT_ELEMENT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu;
const SRC_ATTRIBUTE = /(?:^|\s)src\s*=/iu;
const TYPE_ATTRIBUTE = /(?:^|\s)type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu;
const NONCE_ATTRIBUTE =
  /(?:^|\s)nonce\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu;

const attributeValue = (match: RegExpExecArray | null) =>
  match === null ? null : (match[1] ?? match[2] ?? match[3] ?? "");

/**
 * The inline executable scripts a server-rendered document contains, with
 * their nonce and text. These are the parser-inserted scripts the policy must
 * admit; a script a trusted script inserts later is not part of this set.
 */
export const renderedInlineScripts = (html: string): RenderedInlineScript[] =>
  [...html.matchAll(SCRIPT_ELEMENT)]
    .map((match) => ({ attributes: match[1] ?? "", text: match[2] ?? "" }))
    .filter(
      ({ attributes }) =>
        !SRC_ATTRIBUTE.test(attributes) &&
        EXECUTABLE_SCRIPT_TYPES.has(
          (attributeValue(TYPE_ATTRIBUTE.exec(attributes)) ?? "")
            .trim()
            .toLowerCase(),
        ),
    )
    .map(({ attributes, text }) => ({
      nonce: attributeValue(NONCE_ATTRIBUTE.exec(attributes)) ?? "",
      text,
    }));

export const installContentSecurityPolicyCollector = async (page: Page) => {
  const violations: ContentSecurityPolicyViolation[] = [];
  const policies: (string | undefined)[] = [];
  // The body of the latest enforced document, read once it is complete.
  let latestDocument: Promise<string> | undefined;
  // Keep events in the test process: a reload or an OAuth navigation must not
  // erase violations from the document it leaves.
  await page.exposeBinding(
    "__recordContentSecurityPolicyViolation",
    (_source, violation: ContentSecurityPolicyViolation) => {
      violations.push(violation);
    },
  );
  await page.addInitScript(() => {
    window.__pendingContentSecurityPolicyViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      const delivery = window.__recordContentSecurityPolicyViolation({
        blockedURI: event.blockedURI,
        effectiveDirective: event.effectiveDirective,
        documentURI: event.documentURI,
        sourceFile: event.sourceFile,
        lineNumber: event.lineNumber,
        columnNumber: event.columnNumber,
      });
      window.__pendingContentSecurityPolicyViolations.push(delivery);
    });
  });
  page.on("response", (response) => {
    const request = response.request();
    if (
      request.isNavigationRequest() &&
      request.frame() === page.mainFrame() &&
      response.status() >= 200 &&
      response.status() < 300
    ) {
      policies.push(response.headers()["content-security-policy"]);
      const body = response.text();
      // A document the page leaves before its body completes is superseded by
      // the next one; only the latest is awaited, where a failure surfaces.
      void body.catch(() => undefined);
      latestDocument = body;
    }
  });
  const flushViolations = async () => {
    await page.evaluate(async () => {
      await Promise.all(window.__pendingContentSecurityPolicyViolations);
    });
  };
  return {
    assertClean: async () => {
      const html = await latestDocument;
      if (html === undefined) {
        throw new TypeError("No enforced document response was captured");
      }
      const scripts = renderedInlineScripts(html);
      await flushViolations();
      assertContentSecurityPolicySnapshot({
        violations,
        policies,
        scripts,
      });
    },
    // Call after navigation settles, so the document can acknowledge delivery.
    assertNoViolations: async () => {
      await flushViolations();
      expect(violations, "content security policy violations").toEqual([]);
    },
  };
};
