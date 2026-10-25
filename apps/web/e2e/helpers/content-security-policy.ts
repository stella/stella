// The E2E configuration is node-only; the init script and nonce read run in the browser.
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
    scriptNonces,
    "rendered scripts carry the document policy nonce",
  ).toContain(nonce);
};

export const installContentSecurityPolicyCollector = async (page: Page) => {
  const violations: ContentSecurityPolicyViolation[] = [];
  const policies: (string | undefined)[] = [];
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
    }
  });
  return {
    assertClean: async () => {
      const scriptNonces = await page.evaluate(() =>
        [...document.scripts].map((script) => script.nonce),
      );
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
