import { panic } from "better-result";
import * as v from "valibot";

import { assertSsrDocument } from "@stll/ssr-testkit";

import { E2E_API_ORIGIN } from "../helpers/api";
import { findChromeDividerProblems } from "../helpers/chrome-divider";
import { expect, test } from "../helpers/test";

const PUBLIC_SSR_TIMEOUT_MS = 45_000;
const identityValue = v.pipe(v.string(), v.nonEmpty());
const sessionSchema = v.object({
  user: v.object({
    id: identityValue,
    name: identityValue,
    email: identityValue,
  }),
  session: v.object({ activeOrganizationId: identityValue }),
});
const organizationSchema = v.object({
  id: identityValue,
  name: identityValue,
});

test("public tools render the same document content for both session states", async ({
  context,
  page,
}) => {
  const session = await context.request.get(
    `${E2E_API_ORIGIN}/api/auth/get-session`,
  );
  expect(session.ok()).toBe(true);
  const { user, session: activeSession } = v.parse(
    sessionSchema,
    await session.json(),
  );
  const organizationResponse = await context.request.get(
    `${E2E_API_ORIGIN}/api/auth/organization/get-full-organization`,
    { params: { organizationId: activeSession.activeOrganizationId } },
  );
  expect(organizationResponse.ok()).toBe(true);
  const organization = v.parse(
    organizationSchema,
    await organizationResponse.json(),
  );
  expect(organization.id).toBe(activeSession.activeOrganizationId);
  const identity = {
    userId: user.id,
    userName: user.name,
    userEmail: user.email,
    organizationId: organization.id,
    organizationName: organization.name,
  };

  for (const path of ["/tools", "/tools/contract-review"]) {
    const signedIn = await page.goto(path, {
      timeout: PUBLIC_SSR_TIMEOUT_MS,
      waitUntil: "domcontentloaded",
    });
    expect(signedIn).not.toBeNull();
    if (!signedIn) {
      panic("Expected document response");
    }
    const signedInHtml = await signedIn.text();
    for (const [field, value] of Object.entries(identity)) {
      expect(signedInHtml, `${path}: ${field}`).not.toContain(value);
    }
    assertSsrDocument({
      contentType: signedIn.headers()["content-type"] ?? null,
      html: signedInHtml,
      requiredContent: ["<main", "Contract Review"],
      status: signedIn.status(),
    });
    const main = page.locator("main:not(:has(main))");
    await expect(main).toHaveCount(1);
    await expect(main.getByRole("heading", { level: 1 })).toBeVisible();
    const [signedInContent] = v.parse(
      v.tuple([identityValue]),
      await main.allInnerTexts(),
    );
    const cookies = await context.cookies();
    expect(cookies.length).toBeGreaterThan(0);
    await context.clearCookies();
    const anonymousSession = await context.request.get(
      `${E2E_API_ORIGIN}/api/auth/get-session`,
    );
    expect(anonymousSession.ok()).toBe(true);
    expect(await anonymousSession.json()).toBeNull();
    const anonymous = await page.goto(path, {
      timeout: PUBLIC_SSR_TIMEOUT_MS,
      waitUntil: "domcontentloaded",
    });
    expect(anonymous).not.toBeNull();
    if (!anonymous) {
      panic("Expected document response");
    }
    const anonymousHtml = await anonymous.text();
    assertSsrDocument({
      contentType: anonymous.headers()["content-type"] ?? null,
      html: anonymousHtml,
      requiredContent: ["<main", "Contract Review"],
      status: anonymous.status(),
    });
    await expect(main.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(main).toHaveText(signedInContent, { useInnerText: true });
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
