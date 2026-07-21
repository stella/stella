import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

const AKVIZICE_WORKSPACE_ID = "6cbf3f81-bcc9-55da-8a4e-840221d4cabe";
const EXPORT_REVIEW_WORKSPACE_ID = "bb8641dc-0667-574c-8e30-152a1fd4b3f5";
// Seeded Supplier Agreement redline in the "Meridian supply agreement"
// matter; keep in sync with record-product-story.ts (seed-dev.ts
// `ws-akvizice-energo-doc-7`).
const SUPPLIER_AGREEMENT_ENTITY_ID = "84824638-eb81-58c5-8a81-5d7e961fb7d5";
const SUPPLIER_AGREEMENT_FIELD_ID = "3f985a8b-26be-5a07-89d3-2a05acb94354";
const requestedCapture = process.env["MARKETING_CAPTURE"];

const captures = [
  {
    name: "workspace",
    path: `/workspaces/${AKVIZICE_WORKSPACE_ID}/`,
    prepare: "open-files",
    readyText: "Meridian supply agreement",
  },
  {
    name: "tabular-review",
    path: `/workspaces/${EXPORT_REVIEW_WORKSPACE_ID}/`,
    prepare: "open-table",
    readyText: "Export Review - Project Atlas Data Room",
  },
  // Three different national decisions (CZE, POL, SVK), each rendering with
  // the structured reader (structure/AI margin populated) so the chapter can
  // cross-fade between jurisdictions. Keep in sync with
  // HomeProductStory.astro's data chapter.
  {
    name: "story-public-data-1",
    path: "/law/cases",
    prepare: "open-decision",
    decisionText: "IV.ÚS 1394/24",
    readyText: "Case Law",
    clip: { x: 0, y: 0, width: 1440, height: 760 },
  },
  {
    name: "story-public-data-2",
    path: "/law/cases",
    prepare: "open-decision",
    decisionText: "IV C 1273/16",
    readyText: "Case Law",
    clip: { x: 0, y: 0, width: 1440, height: 760 },
  },
  {
    name: "story-public-data-3",
    path: "/law/cases",
    prepare: "open-decision",
    decisionText: "25Cbr/166/2024",
    readyText: "Case Law",
    clip: { x: 0, y: 0, width: 1440, height: 760 },
  },
  {
    name: "editor",
    path:
      `/workspaces/${AKVIZICE_WORKSPACE_ID}/all/document` +
      "?editing=true" +
      `&entity=${SUPPLIER_AGREEMENT_ENTITY_ID}` +
      `&field=${SUPPLIER_AGREEMENT_FIELD_ID}`,
    readyText: "Supplier_Agreement.docx",
    readySelector: ".layout-run-text",
  },
  { name: "agent", path: "/chat/new", readyText: "Chat" },
  {
    name: "public-data",
    path: "/law/cases",
    prepare: "open-decision",
    decisionText: "IV.ÚS 1394/24",
    readyText: "Case Law",
  },
  { name: "templates", path: "/knowledge/templates", readyText: "Templates" },
  {
    name: "anonymization",
    path:
      `/workspaces/${AKVIZICE_WORKSPACE_ID}/all/document` +
      "?entity=c3dc74a6-7855-5157-84db-ddf14f886df4" +
      "&field=e98a6746-dae9-5509-888b-d58bfbca9a33",
    readyText: "Redacted_Due_Diligence_Extract.docx",
    readySelector: ".layout-run-text",
  },
] as const;

test("capture landing product screenshots", async ({
  context,
  page,
  request,
}) => {
  await authenticateMarketingSession(request);
  const { cookies } = await request.storageState();
  await context.addCookies(cookies);
  await page.addInitScript(() => {
    localStorage.setItem("theme", "light");
  });

  await page.goto("/workspaces", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /Test Firm/u }).click();

  for (const theme of ["light", "dark"] as const) {
    // eslint-disable-next-line no-await-in-loop -- captures reuse one authenticated page, so each theme switch and capture must be prepared and shot in order
    await page.emulateMedia({ colorScheme: theme });
    // eslint-disable-next-line no-await-in-loop -- see above
    await page.evaluate((nextTheme) => {
      localStorage.setItem("theme", nextTheme);
    }, theme);

    for (const capture of captures) {
      if (requestedCapture && capture.name !== requestedCapture) {
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- see above
      await page.goto(capture.path, { waitUntil: "domcontentloaded" });
      // eslint-disable-next-line no-await-in-loop -- see above
      await expect(page).not.toHaveURL(/\/sign-in(?:\/|\?|$)/u);
      // eslint-disable-next-line no-await-in-loop -- see above
      await expect(page.getByText(capture.readyText).first()).toBeVisible();
      if ("readySelector" in capture) {
        // eslint-disable-next-line no-await-in-loop -- see above
        await expect(page.locator(capture.readySelector).first()).toBeVisible();
      }
      if ("prepare" in capture && capture.prepare === "open-decision") {
        // Film a specific national decision deterministically, rather than
        // whatever happens to be newest in the seeded corpus.
        // eslint-disable-next-line no-await-in-loop -- see above
        await page
          .locator('main a[href*="/cases/"]')
          .filter({ hasText: capture.decisionText })
          .click();
        // eslint-disable-next-line no-await-in-loop -- see above
        await expect(page).toHaveURL(/\/law\/[a-z-]+\/cases\//u);
        // eslint-disable-next-line no-await-in-loop -- see above
        await expect(page.locator("article").first()).toBeVisible();
        // The reader briefly renders a logged-out "locked" AI button while
        // the client-side session query settles (useClientAuthStatus), then
        // swaps in the authenticated workspace. Wait for that swap so the
        // click below hits the real analyze button, not the sign-in prompt.
        // eslint-disable-next-line no-await-in-loop -- see above
        await page.waitForLoadState("networkidle");
        // The structure/AI margin is generated on demand. These decisions
        // already have their analysis cached server-side, but the client
        // still needs one round trip to fetch it; trigger it explicitly and
        // wait for the outline rail so the capture never lands on the
        // empty/loading margin state.
        // eslint-disable-next-line no-await-in-loop -- see above
        const analyzeButton = page.getByRole("button", {
          name: "Analyze with AI",
        });
        // eslint-disable-next-line no-await-in-loop -- see above
        await expect(analyzeButton).toBeVisible();
        // eslint-disable-next-line no-await-in-loop -- see above
        await analyzeButton.click();
        // eslint-disable-next-line no-await-in-loop -- see above
        await expect(
          page.getByRole("group", { name: "Outline" }),
        ).toBeVisible();
        // The first margin annotation may sit below a long headnote (e.g. a
        // Constitutional Court "legal sentence" summary); scroll it into view
        // so the capture shows the structure margin, not just headnote text.
        // eslint-disable-next-line no-await-in-loop -- see above
        await page.locator("aside button").first().scrollIntoViewIfNeeded();
      }
      if ("prepare" in capture && capture.prepare === "open-files") {
        // eslint-disable-next-line no-await-in-loop -- see above
        await page.getByRole("tab", { name: "Files" }).click();
        // eslint-disable-next-line no-await-in-loop -- see above
        await expect(page).toHaveURL(
          new RegExp(`/workspaces/${AKVIZICE_WORKSPACE_ID}/[^/?]+`, "u"),
        );
        // eslint-disable-next-line no-await-in-loop -- see above
        await expect(
          page.getByText("Internal_SAFE_Agreement.docx").first(),
        ).toBeVisible();
      }
      if ("prepare" in capture && capture.prepare === "open-table") {
        // eslint-disable-next-line no-await-in-loop -- see above
        await page.getByRole("tab", { name: "Table" }).click();
        // eslint-disable-next-line no-await-in-loop -- see above
        await expect(page.getByRole("grid")).toBeVisible();
      }
      // eslint-disable-next-line no-await-in-loop -- see above
      await page.locator("body").waitFor({ state: "visible" });
      // eslint-disable-next-line no-await-in-loop -- see above
      await page.evaluate(async () => document.fonts.ready);
      // eslint-disable-next-line no-await-in-loop -- see above
      await page.waitForTimeout(300);
      // eslint-disable-next-line no-await-in-loop -- see above
      await page.addStyleTag({
        content: `
          *, *::before, *::after {
            animation-delay: 0s !important;
            animation-duration: 0s !important;
            caret-color: transparent !important;
            transition-duration: 0s !important;
          }
          [data-sonner-toaster], [data-testid="devtools"] { display: none !important; }
        `,
      });

      const themeSuffix = theme === "dark" ? "-dark" : "";
      // eslint-disable-next-line no-await-in-loop -- see above
      await expect(page).toHaveScreenshot(`${capture.name}${themeSuffix}.png`, {
        animations: "disabled",
        caret: "hide",
        clip:
          "clip" in capture
            ? capture.clip
            : { x: 255, y: 0, width: 1137, height: 710 },
        maxDiffPixelRatio: 0.001,
        scale: "css",
      });
    }
  }
});

const authenticateMarketingSession = async (request: APIRequestContext) => {
  const apiBaseURL = process.env["E2E_API_URL"] ?? "http://localhost:3001";
  const webOrigin = new URL(
    process.env["E2E_WEB_URL"] ?? "http://localhost:3000",
  ).origin;
  const email = "test@stella.dev";
  const sendResponse = await request.post(
    `${apiBaseURL}/api/auth/email-otp/send-verification-otp`,
    { data: { email, type: "sign-in" }, headers: { origin: webOrigin } },
  );
  expect(sendResponse.ok(), await sendResponse.text()).toBe(true);

  const otpResponse = await request.get(
    `${apiBaseURL}/dev-public/last-otp?email=${encodeURIComponent(email)}`,
  );
  expect(otpResponse.ok()).toBe(true);
  const { otp } = await otpResponse.json();

  const signInResponse = await request.post(
    `${apiBaseURL}/api/auth/sign-in/email-otp`,
    { data: { email, otp }, headers: { origin: webOrigin } },
  );
  expect(signInResponse.ok(), await signInResponse.text()).toBe(true);
};
