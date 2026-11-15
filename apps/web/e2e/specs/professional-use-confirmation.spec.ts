import { request as playwrightRequest } from "@playwright/test";
import { randomUUID } from "node:crypto";
import * as v from "valibot";

import { CAPABILITY_REQUEST_HEADER } from "@stll/api-contract/capability-request";
import { organizationCreateOutputSchema } from "@stll/api-contract/organization-create";
import { PROFESSIONAL_USE_STATEMENT_VERSION } from "@stll/api-contract/professional-use";

import { E2E_API_ORIGIN } from "../helpers/api";
import {
  signInWithEmailOtp,
  signInWithEmailOtpWithoutProfessionalUse,
} from "../helpers/sign-in";
import { expect, test } from "../helpers/test";

// The matters route sets its title only once the protected guard has let it
// load, so a missing confirmation is asserted on the loaded page.
const MATTERS_TITLE = "Matters | stella";

const createSignedInAccount = async (
  signIn: typeof signInWithEmailOtp = signInWithEmailOtp,
) => {
  const api = await playwrightRequest.newContext({
    extraHTTPHeaders: { origin: "http://localhost:3000" },
  });
  const suffix = randomUUID().slice(0, 8);
  await signIn(api, `professional-use-${suffix}@stella.dev`);
  const organization = await api.post(`${E2E_API_ORIGIN}/v1/organizations`, {
    data: { name: `Professional Use ${suffix}`, slug: `pro-use-${suffix}` },
    headers: {
      "Idempotency-Key": `pro-use-${suffix}`,
      [CAPABILITY_REQUEST_HEADER]: "organizations.create",
    },
  });
  expect(organization.ok(), await organization.text()).toBe(true);
  const created = v.parse(
    organizationCreateOutputSchema,
    await organization.json(),
  );
  const activation = await api.post(
    `${E2E_API_ORIGIN}/api/auth/organization/set-active`,
    { data: { organizationId: created.organizationId } },
  );
  expect(activation.ok(), await activation.text()).toBe(true);
  return api;
};

test("an account awaiting confirmation sees the statement and enters the product after accepting", async ({
  page,
}) => {
  const api = await createSignedInAccount(
    signInWithEmailOtpWithoutProfessionalUse,
  );
  try {
    await page.context().addCookies((await api.storageState()).cookies);

    await page.goto("/workspaces", { waitUntil: "commit" });
    await expect(
      page.getByText("Confirm professional use", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "By creating an account, you confirm that you use stella for professional purposes and understand that stella is a tool for legal professionals and not a substitute for legal advice.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await page.getByRole("button", { name: "Accept" }).click();
    await expect(page).toHaveURL(/\/workspaces\/?$/u);
    await expect(page).toHaveTitle(MATTERS_TITLE);
    await expect(
      page.getByText("Confirm professional use", { exact: true }),
    ).not.toBeVisible();
  } finally {
    await api.dispose();
  }
});

test("an account with a recorded acceptance enters the product without the card", async ({
  page,
}) => {
  const api = await createSignedInAccount();
  try {
    const accepted = await api.post(
      `${E2E_API_ORIGIN}/v1/me/professional-use`,
      {
        data: { statementVersion: PROFESSIONAL_USE_STATEMENT_VERSION },
      },
    );
    expect(accepted.ok(), await accepted.text()).toBe(true);
    await page.context().addCookies((await api.storageState()).cookies);
    await page.goto("/workspaces", { waitUntil: "commit" });
    await expect(page).toHaveURL(/\/workspaces\/?$/u);
    await expect(page).toHaveTitle(MATTERS_TITLE);
    await expect(
      page.getByText("Confirm professional use", { exact: true }),
    ).not.toBeVisible();
  } finally {
    await api.dispose();
  }
});
