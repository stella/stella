import { panic } from "better-result";

import { installContentSecurityPolicyCollector } from "../helpers/content-security-policy";
import { pushRouterPath } from "../helpers/decision-reader";
import {
  DOCKED_CHAT_LEGAL_ROUTES,
  installDockedLegalFixtures,
} from "../helpers/docked-chat-legal-fixtures";
import { dockedChatLegalPayloads } from "../helpers/docked-chat-legal-payloads";
import { createUploadedDocumentRoute } from "../helpers/document";
import { expect, test } from "../helpers/test";
import { createTestWorkspace, deleteTestWorkspace } from "../helpers/workspace";

test.describe("authenticated content security policy", () => {
  test.use({ locale: "en-US" });

  test("chat hydrates and accepts input with the enforced policy", async ({
    page,
  }) => {
    const policy = await installContentSecurityPolicyCollector(page);
    await page.goto("/chat/new", { waitUntil: "domcontentloaded" });
    const main = page.getByRole("main");
    await expect(main).toBeVisible();
    const composer = main.getByRole("textbox", {
      name: /type your question/iu,
    });
    await composer.fill("CSP hydration check");
    await expect(composer).toHaveText("CSP hydration check");
    await policy.assertClean();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(main).toBeVisible();
    await composer.fill("CSP reload check");
    await expect(composer).toHaveText("CSP reload check");
    await policy.assertClean();
  });
});

test.describe("public legal reader content security policy", () => {
  test.use({ storageState: { cookies: [], origins: [] }, locale: "en-US" });

  for (const surface of ["decision", "statute"] as const) {
    test(`${surface} reader renders without policy violations`, async ({
      page,
    }) => {
      const policy = await installContentSecurityPolicyCollector(page);
      await installDockedLegalFixtures(page);
      // Browser fixtures intercept client loader reads. /auth is client-rendered:
      // its form proves hydration finished before the history transition.
      await page.goto("/auth", { waitUntil: "domcontentloaded" });
      await expect(page.locator('input[type="email"]')).toBeVisible();
      await policy.assertClean();
      const destination = DOCKED_CHAT_LEGAL_ROUTES[surface].path;
      const firstParagraph =
        dockedChatLegalPayloads[surface].fulltext.split("\n\n").at(0) ??
        panic("Legal reader fixture has no text");
      await pushRouterPath(page, destination);
      await expect(page.getByText(firstParagraph, { exact: true })).toBeVisible(
        {
          timeout: 30_000,
        },
      );
      await expect(page).toHaveURL((url) => url.pathname === destination);
      await policy.assertClean();
    });
  }
});

test("PDF viewer paints its first page without policy violations", async ({
  page,
  request,
}, testInfo) => {
  const workspace = await createTestWorkspace(request, "csp-pdf");
  try {
    const document = await createUploadedDocumentRoute({
      fileName: "csp-viewer.pdf",
      fixture: "pdf",
      request,
      workspace,
    });
    const { cookies } = await request.storageState();
    await page.context().addCookies(cookies);
    const policy = await installContentSecurityPolicyCollector(page);
    await page.goto(document.path, { waitUntil: "domcontentloaded" });
    // The viewer appends the canvas and text layer only after both pdf.js
    // rendering promises resolve, so a pending shell cannot satisfy this.
    const firstPage = page.locator("[data-page-id]").first();
    await expect(firstPage.locator("canvas")).toBeVisible({ timeout: 45_000 });
    await expect(firstPage.locator("[data-text-layer]")).toContainText(
      "Native text page one",
    );
    await policy.assertClean();
  } finally {
    await deleteTestWorkspace(request, workspace.id, {
      leave: { page, testInfo },
    });
  }
});
