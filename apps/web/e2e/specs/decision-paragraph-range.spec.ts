import type { Page } from "@playwright/test";

import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@stll/api-contract/case-law-decision-route";

import { E2E_API_ORIGIN } from "../helpers/api";
import { decisionParagraphRangePayloads } from "../helpers/decision-paragraph-range-payloads";
import { installDockedLegalFixtures } from "../helpers/docked-chat-legal-fixtures";
import { expect, test } from "../helpers/test";

const { decision } = decisionParagraphRangePayloads;

const routeInput = {
  caseNumber: decision.caseNumber,
  country: decision.country,
  court: decision.court,
  decisionId: decision.id,
  language: decision.language,
  languageAlternates: decision.languageAlternates,
  slug: decision.slug,
};
const canonicalPath = createCaseLawDecisionPath(
  createCaseLawDecisionRouteParams(routeInput),
);
const idPath = createCaseLawDecisionPath(
  createCaseLawDecisionRouteParams({ ...routeInput, slug: null }),
);

const installParagraphFixture = async (page: Page) => {
  await installDockedLegalFixtures(page);
  await page.route(
    (url) =>
      url.origin === E2E_API_ORIGIN &&
      (url.pathname === `/v1/case/decisions/${decision.id}` ||
        url.pathname === `/v1/case/decisions/by-slug/${decision.slug}`),
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({ json: decision });
    },
  );
};

// A direct load renders the decision on the server, where page.route cannot
// answer the decision read; boot the app on a public page and navigate on the
// client so the read comes from the browser (as provision-layout-fixture does).
// The router's history wraps pushState once it mounts; a push before that is a
// bare URL change, so wait for the wrapper first.
const openDecision = async (page: Page, path: string) => {
  await page.goto("/law", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => !history.pushState.toString().includes("[native code]"),
  );
  await page.evaluate((target) => {
    history.pushState(null, "", target);
  }, path);
};

test.describe("court paragraph deep links", () => {
  test.use({ storageState: { cookies: [], origins: [] }, locale: "en-US" });

  test("canonicalizes the URL, scrolls to court numbers and updates range highlights on hash navigation", async ({
    page,
  }) => {
    await installParagraphFixture(page);
    expect(idPath).not.toBe(canonicalPath);
    await openDecision(page, `${idPath}#par=48-53`);
    await expect(page).toHaveURL(`${canonicalPath}#par=48-53`);

    const reader = page.locator(".reader-scroll");
    const first = reader.locator('[data-anchor="p-28"]');
    const highlights = reader.locator("article [data-reader-landing]");
    await expect(highlights).toHaveCount(6);
    for (const paragraph of await highlights.all()) {
      await expect(paragraph).toHaveClass(/\bbg-accent\b/u);
      await expect(paragraph).toHaveClass(/\btext-accent-foreground\b/u);
    }
    await expect(first).toBeFocused();
    await expect(reader.getByRole("status")).toHaveText(
      "Paragraphs 48-53 highlighted.",
    );
    await expect
      .poll(async () => reader.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await expect
      .poll(async () =>
        first.evaluate((element) => {
          const viewport = element
            .closest(".reader-scroll")
            ?.getBoundingClientRect();
          const paragraph = element.getBoundingClientRect();
          return (
            viewport !== undefined &&
            paragraph.top >= viewport.top &&
            paragraph.top < viewport.bottom
          );
        }),
      )
      .toBe(true);
    expect(
      await highlights.evaluateAll((elements) =>
        elements.map((element) => element.dataset["anchor"]),
      ),
    ).toEqual(["p-28", "p-29", "p-30", "p-31", "p-32", "p-33"]);
    await expect(reader.locator('[data-anchor="p-48"]')).not.toHaveAttribute(
      "data-reader-landing",
    );

    await page.evaluate(() => {
      window.location.hash = "par=49";
    });
    await expect(highlights).toHaveCount(1);
    await expect(highlights).toHaveAttribute("data-anchor", "p-29");
    await expect(reader.locator('[data-anchor="p-29"]')).toBeFocused();
    await expect(first).not.toHaveClass(/\bbg-accent\b/u);
    await expect(first).not.toHaveAttribute("tabindex");
    await expect(reader.getByRole("status")).toHaveText(
      "Paragraph 49 highlighted.",
    );

    await page.evaluate(() => {
      window.location.hash = "";
    });
    await expect(highlights).toHaveCount(0);
    await expect(reader.getByRole("status")).toHaveCount(0);
    await expect(reader.locator('[data-anchor="p-29"]')).not.toHaveClass(
      /\bbg-accent\b/u,
    );
  });

  for (const { fragment, message } of [
    { fragment: "par=999", message: "Paragraph 999 not found in this text." },
    {
      fragment: "par=48-101",
      message: "Paragraphs 48-101 not found in this text.",
    },
  ]) {
    test(`shows a notice at the top when ${fragment} cannot address court paragraphs`, async ({
      page,
    }) => {
      await installParagraphFixture(page);
      await openDecision(page, `${canonicalPath}#par=48-53`);
      const reader = page.locator(".reader-scroll");
      await expect(reader.locator("article [data-reader-landing]")).toHaveCount(
        6,
      );
      await expect
        .poll(async () => reader.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);

      await page.evaluate((hash) => {
        window.location.hash = hash;
      }, fragment);
      const notice = reader.getByRole("status");
      await expect(notice).toHaveText(message);
      await expect(notice).toBeInViewport();
      await expect(notice).not.toHaveClass(/\bsr-only\b/u);
      await expect(reader.locator("article [data-reader-landing]")).toHaveCount(
        0,
      );
      await expect
        .poll(async () => reader.evaluate((element) => element.scrollTop))
        .toBe(0);
    });
  }
  for (const fragment of ["par=53-48", "par=48a", "par=1-501"]) {
    test(`invalid fragment ${fragment} opens normally without a range notice`, async ({
      page,
    }) => {
      await installParagraphFixture(page);
      await openDecision(page, `${canonicalPath}#${fragment}`);
      await expect(page).toHaveURL(`${canonicalPath}#${fragment}`);
      const reader = page.locator(".reader-scroll");
      await expect(reader.locator('[data-anchor="p-1"]')).toBeInViewport();
      await expect(reader.locator("article [data-reader-landing]")).toHaveCount(
        0,
      );
      await expect(reader.getByRole("status")).toHaveCount(0);

      await page.evaluate(() => {
        window.location.hash = "par=48-53";
      });
      await expect(reader.locator("article [data-reader-landing]")).toHaveCount(
        6,
      );
      await page.evaluate((hash) => {
        window.location.hash = hash;
      }, fragment);
      await expect(page).toHaveURL(`${canonicalPath}#${fragment}`);
      await expect(reader.locator("article [data-reader-landing]")).toHaveCount(
        0,
      );
      await expect(reader.getByRole("status")).toHaveCount(0);
    });
  }

  test("a decision without an AST retains its existing unavailable state", async ({
    page,
  }) => {
    await installParagraphFixture(page);
    await page.route(
      (url) =>
        url.origin === E2E_API_ORIGIN &&
        url.pathname === `/v1/case/decisions/by-slug/${decision.slug}`,
      async (route) => {
        await route.fulfill({
          json: decisionParagraphRangePayloads.unavailable,
        });
      },
    );
    await openDecision(page, `${canonicalPath}#par=48-53`);
    await expect(page).toHaveURL(`${canonicalPath}#par=48-53`);
    await expect(
      page.getByText(
        "The court has not published the decision text, or it is not available here yet.",
        {
          exact: true,
        },
      ),
    ).toBeVisible();
    await expect(page.locator("article [data-reader-landing]")).toHaveCount(0);
    await expect(
      page.getByText("Paragraphs 48-53 not found in this text.", {
        exact: true,
      }),
    ).toHaveCount(0);
  });
});
