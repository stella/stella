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

  expect(response?.status()).toBe(200);
  const html = await response?.text();
  expect(html).toContain("<main");
  expect(html).toContain('href="/tools/contract-review"');
});

test("anonymous visitors can search and browse by legal task", async ({
  context,
  page,
}) => {
  await context.clearCookies();
  await page.goto("/tools", {
    timeout: PUBLIC_SSR_TIMEOUT_MS,
    waitUntil: "networkidle",
  });

  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Make stella fit the legal work in front of you",
    }),
  ).toBeVisible();

  const search = page.getByRole("searchbox", {
    name: "What do you need to do?",
  });
  await search.fill("Companies House");
  await expect(
    page.getByRole("link", { name: /Companies House/u }),
  ).toBeVisible();
  await expect(page.getByText("1 result", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "A better place to start" }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "Clear search" }).click();
  await page.getByRole("button", { name: "Review agreements" }).click();
  await expect(
    page.getByRole("link", { name: /Contract Review/u }),
  ).toBeVisible();
  await expect(page.getByText("1 result", { exact: true })).toBeVisible();
});
