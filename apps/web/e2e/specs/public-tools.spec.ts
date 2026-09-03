import { assertSsrDocument } from "@stll/ssr-testkit";

import { expect, test } from "../helpers/test";

const PUBLIC_SSR_TIMEOUT_MS = 45_000;

test("public tools catalogue returns SSR content for anonymous visitors", async ({
  context,
  page,
}) => {
  await context.clearCookies();

  const response = await page.goto("/tools", {
    timeout: PUBLIC_SSR_TIMEOUT_MS,
    waitUntil: "commit",
  });

  assertSsrDocument({
    contentType: response?.headers()["content-type"] ?? null,
    html: (await response?.text()) ?? "",
    requiredContent: ["<main", 'href="/tools/contract-review"'],
    status: response?.status() ?? 0,
  });
});

test("anonymous visitors can search and browse by legal task", async ({
  context,
  page,
}) => {
  await context.clearCookies();
  const pageErrors: string[] = [];
  const hydrationErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error" && /hydrated|hydration/iu.test(text)) {
      hydrationErrors.push(text);
    }
  });
  await page.goto("/tools", {
    timeout: PUBLIC_SSR_TIMEOUT_MS,
    waitUntil: "domcontentloaded",
  });

  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  const workflowDiscovery = page.locator(
    'section[aria-labelledby="featured-tools-heading"]',
  );
  await expect(workflowDiscovery).toBeVisible();

  const search = page.getByRole("searchbox", {
    name: "What do you need to do?",
  });
  // The route is SSR'd, so its controls can be visible just before React has
  // attached event handlers. Retry the first interaction until hydration has
  // accepted it rather than treating the static markup as client-ready.
  await expect(async () => {
    await search.fill("");
    await search.fill("Companies House");
    await expect(page.getByText("1 result", { exact: true })).toBeVisible({
      timeout: 1000,
    });
  }).toPass({ timeout: 15_000 });
  await expect(
    page.getByRole("link", { name: /Companies House/u }),
  ).toBeVisible();
  await expect(workflowDiscovery).toHaveCount(0);

  await page.getByRole("button", { name: "Clear search" }).click();
  await page.getByRole("button", { name: "Review agreements" }).click();
  await expect(
    page.getByRole("link", { name: /Contract Review/u }),
  ).toBeVisible();
  await expect(page.getByText("1 result", { exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
  expect(hydrationErrors).toEqual([]);
});
