// The E2E configuration is node-only; the init script runs in the browser.
/// <reference lib="dom" />
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

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
    __recordContentSecurityPolicyViolation: (
      violation: ContentSecurityPolicyViolation,
    ) => Promise<void>;
  }
}

type ContentSecurityPolicySnapshot = {
  violations: readonly ContentSecurityPolicyViolation[];
  policies: readonly (string | undefined)[];
  scriptNonces: readonly string[];
};

export const assertContentSecurityPolicySnapshot = ({
  violations,
  policies,
  scriptNonces,
}: ContentSecurityPolicySnapshot) => {
  expect(violations, "content security policy violations").toEqual([]);
  expect(
    policies.length,
    "enforced document policies captured",
  ).toBeGreaterThan(0);
  for (const policy of policies) {
    expect(policy, "document content-security-policy header").toBeTruthy();
    expect(policy, "document policy nonce").toMatch(/'nonce-[^']+'/u);
  }
  const nonce = /'nonce-([^']+)'/u.exec(policies.at(-1) ?? "")?.[1];
  expect(
    scriptNonces.length,
    "rendered inline scripts captured",
  ).toBeGreaterThan(0);
  // Every inline script, not just one: a single unnonced script among nonced
  // ones is still blocked by the policy.
  expect(
    scriptNonces.filter((scriptNonce) => scriptNonce !== nonce),
    "rendered scripts carry the document policy nonce",
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
const SCRIPT_OPENING_TAG = /<script\b([^>]*)>/giu;
const SRC_ATTRIBUTE = /(?:^|\s)src\s*=/iu;
const TYPE_ATTRIBUTE = /(?:^|\s)type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu;
const NONCE_ATTRIBUTE =
  /(?:^|\s)nonce\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu;

const attributeValue = (match: RegExpExecArray | null) =>
  match === null ? null : (match[1] ?? match[2] ?? match[3] ?? "");

/**
 * The nonces of the inline executable scripts a server-rendered document
 * contains. These are the parser-inserted scripts the nonce must admit; a
 * script a trusted script inserts later runs under `'strict-dynamic'` and is
 * not part of this set.
 */
export const renderedInlineScriptNonces = (html: string): string[] =>
  [...html.matchAll(SCRIPT_OPENING_TAG)]
    .map((match) => match[1] ?? "")
    .filter(
      (attributes) =>
        !SRC_ATTRIBUTE.test(attributes) &&
        EXECUTABLE_SCRIPT_TYPES.has(
          (attributeValue(TYPE_ATTRIBUTE.exec(attributes)) ?? "")
            .trim()
            .toLowerCase(),
        ),
    )
    .map(
      (attributes) => attributeValue(NONCE_ATTRIBUTE.exec(attributes)) ?? "",
    );

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
    document.addEventListener("securitypolicyviolation", (event) => {
      void window.__recordContentSecurityPolicyViolation({
        blockedURI: event.blockedURI,
        effectiveDirective: event.effectiveDirective,
        documentURI: event.documentURI,
        sourceFile: event.sourceFile,
        lineNumber: event.lineNumber,
        columnNumber: event.columnNumber,
      });
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
  return {
    assertClean: async () => {
      const html = await latestDocument;
      if (html === undefined) {
        throw new TypeError("No enforced document response was captured");
      }
      const scriptNonces = renderedInlineScriptNonces(html);
      assertContentSecurityPolicySnapshot({
        violations,
        policies,
        scriptNonces,
      });
    },
    // Reads only what the test process already holds, so it is safe while
    // the page is leaving its document (a held navigation request), where a
    // page evaluation can wait for a context that never settles.
    assertNoViolations: () => {
      expect(violations, "content security policy violations").toEqual([]);
    },
  };
};
