import { assertSsrDocument } from "@stll/ssr-testkit";

import { E2E_API_ORIGIN } from "../helpers/api";
import { findChromeDividerProblems } from "../helpers/chrome-divider";
import { expect, test } from "../helpers/test";

const PUBLIC_SSR_TIMEOUT_MS = 45_000;

test("public tools render the same document content for both session states", async ({
  context,
  page,
}) => {
  const session = await context.request.get(
    `${E2E_API_ORIGIN}/api/auth/get-session`,
  );
  expect(session.ok()).toBe(true);
  expect(await session.json()).toMatchObject({
    user: { id: expect.any(String) },
  });

  for (const path of ["/tools", "/tools/contract-review"]) {
    const signedIn = await context.request.get(path, {
      timeout: PUBLIC_SSR_TIMEOUT_MS,
    });
    const signedInHtml = await signedIn.text();
    assertSsrDocument({
      contentType: signedIn.headers()["content-type"] ?? null,
      html: signedInHtml,
      requiredContent: ["<main", "Contract Review"],
      status: signedIn.status(),
    });
    const cookies = await context.cookies();
    expect(cookies.length).toBeGreaterThan(0);
    await context.clearCookies();
    const anonymousSession = await context.request.get(
      `${E2E_API_ORIGIN}/api/auth/get-session`,
    );
    expect(anonymousSession.ok()).toBe(true);
    expect(await anonymousSession.json()).toBeNull();
    const anonymous = await context.request.get(path, {
      timeout: PUBLIC_SSR_TIMEOUT_MS,
    });
    const anonymousHtml = await anonymous.text();
    assertSsrDocument({
      contentType: anonymous.headers()["content-type"] ?? null,
      html: anonymousHtml,
      requiredContent: ["<main", "Contract Review"],
      status: anonymous.status(),
    });
    const documents = await page.evaluate(
      (htmlDocuments) =>
        htmlDocuments.map((html) => {
          const document = new DOMParser().parseFromString(html, "text/html");
          // Streaming scripts contain per-request router timing data.
          for (const script of document.querySelectorAll("script")) {
            script.remove();
          }
          return document.documentElement.outerHTML;
        }),
      [signedInHtml, anonymousHtml],
    );
    expect(documents.at(0)).toBe(documents.at(1));
    expect(signedIn.headers()["cache-control"]).toBe("private, no-store");
    expect(anonymous.headers()["cache-control"]).toBe("private, no-store");
    expect(signedIn.headers()["x-robots-tag"]).toBe(
      anonymous.headers()["x-robots-tag"],
    );
    await context.addCookies(cookies);
  }
});

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
  // The public shell's top bar owns the divider under its breadcrumb too.
  expect(await findChromeDividerProblems(page)).toEqual([]);

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
