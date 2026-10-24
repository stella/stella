import { E2E_API_ORIGIN } from "../helpers/api";
import { expect, test } from "../helpers/test";

const RETURN_PATH = "/settings/account/profile";
const RETURN_SEARCH = new URLSearchParams({
  redirectTo: RETURN_PATH,
}).toString();

test("email reauthentication keeps the current session while showing the OTP challenge", async ({
  page,
}) => {
  const sessionUrl = `${E2E_API_ORIGIN}/api/auth/get-session`;
  const previousResponse = await page.request.get(sessionUrl);
  const previousSession = await previousResponse.json();
  expect(previousSession).toMatchObject({
    session: { id: expect.any(String) },
  });
  let signOutCount = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/sign-out")) {
      signOutCount += 1;
    }
  });
  await page.route(
    "**/api/auth/email-otp/send-verification-otp",
    async (route) => {
      await route.fulfill({ json: { success: true } });
    },
  );
  await page.route("**/dev-public/last-otp?**", async (route) => {
    await route.fulfill({ json: null });
  });
  await page.goto(`/auth/reauth?${RETURN_SEARCH}`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByPlaceholder("you@example.com").fill("reader@example.test");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page).toHaveURL(/\/auth\/otp\?.*mode=reauthenticate/u);
  await expect(
    page.getByRole("button", { name: "Verify", exact: true }),
  ).toBeVisible();
  const challengeResponse = await page.request.get(sessionUrl);
  expect(await challengeResponse.json()).toMatchObject({
    session: { id: previousSession.session.id },
  });
  expect(signOutCount).toBe(0);
  await page
    .getByRole("button", { name: "Use a different email", exact: true })
    .click();
  await expect(page).toHaveURL(
    new URL(`/auth/reauth?${RETURN_SEARCH}`, page.url()).href,
  );
});

test("an ordinary OTP link redirects an already signed-in account", async ({
  page,
}) => {
  await page.goto(`/auth/otp?email=reader%40example.test&${RETURN_SEARCH}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page).toHaveURL(new URL(RETURN_PATH, page.url()).href);
  await expect(
    page.getByRole("button", { name: "Verify", exact: true }),
  ).toHaveCount(0);
});
