import { expect, test } from "../helpers/test";

for (const destination of ["/workspaces", "/law?country=cze"]) {
  test(`handoff confirms the account before entering ${destination}`, async ({
    page,
  }) => {
    const requests: unknown[] = [];
    await page.route("**/api/auth/mcp-handoff/redeem", async (route) => {
      requests.push(route.request().postDataJSON());
      await route.fulfill({
        json:
          requests.length === 1
            ? {
                status: "needs_confirmation",
                email: "reader@example.test",
                organizationName: "Example legal team",
              }
            : { status: "redeemed" },
      });
    });
    await page.goto(`${destination}#section=2&sh=sh1_browser_fixture`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page).toHaveURL(/\/auth\/handoff$/u);
    await expect(
      page.getByText("Continue as reader@example.test in Example legal team?", {
        exact: true,
      }),
    ).toBeVisible();
    expect(requests).toEqual([
      { code: "sh1_browser_fixture", path: destination },
    ]);
    const confirmationDocument = await page.request.get(page.url());
    expect(confirmationDocument.headers()["cache-control"]).toContain(
      "no-store",
    );
    expect(confirmationDocument.headers()["referrer-policy"]).toBe(
      "no-referrer",
    );
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(page).toHaveURL(
      new URL(`${destination}#section=2`, page.url()).href,
    );
    expect(requests).toEqual([
      { code: "sh1_browser_fixture", path: destination },
      {
        code: "sh1_browser_fixture",
        path: destination,
        confirmation: "confirmed",
      },
    ]);
    expect(page.url()).not.toContain("sh=");
  });
}

test("public law reads return the same bytes with and without a browser session", async ({
  request,
  playwright,
}) => {
  const apiUrl = process.env["E2E_API_URL"] ?? "http://localhost:3001";
  const publicUrl = `${apiUrl}/v1/case/decisions/latest?country=cze`;
  const anonymous = await playwright.request.newContext({
    storageState: { cookies: [], origins: [] },
  });
  const signedInSession = await request.get(`${apiUrl}/api/auth/get-session`);
  expect(await signedInSession.json()).toMatchObject({
    session: { userId: expect.any(String) },
  });
  const anonymousSession = await anonymous.get(
    `${apiUrl}/api/auth/get-session`,
  );
  expect(await anonymousSession.json()).toBeNull();
  const [signedInResponse, anonymousResponse] = await Promise.all([
    request.get(publicUrl),
    anonymous.get(publicUrl),
  ]);
  expect(signedInResponse.status()).toBe(200);
  expect(anonymousResponse.status()).toBe(200);
  expect(
    (await signedInResponse.body()).equals(await anonymousResponse.body()),
  ).toBe(true);
  for (const response of [signedInResponse, anonymousResponse]) {
    const headers = response.headers();
    if (headers["set-cookie"]) {
      expect(headers["cache-control"]).toContain("no-store");
    }
  }
  await anonymous.dispose();
});

test.describe("signed-out public-law handoff", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("a refused handoff leaves public law readable without signing in", async ({
    page,
  }) => {
    let redemptionCount = 0;
    await page.route("**/api/auth/mcp-handoff/redeem", async (route) => {
      redemptionCount += 1;
      await route.fulfill({ json: { status: "refused" } });
    });
    await page.goto("/law?country=cze#section=2&sh=sh1_browser_fixture", {
      waitUntil: "domcontentloaded",
    });
    await expect(page).toHaveURL(
      new URL("/law?country=cze#section=2", page.url()).href,
    );
    await expect(page.locator("main")).toBeVisible();
    await expect.poll(() => redemptionCount).toBe(1);
    const apiUrl = process.env["E2E_API_URL"] ?? "http://localhost:3001";
    const session = await page.request.get(`${apiUrl}/api/auth/get-session`);
    expect(await session.json()).toBeNull();
  });
});
