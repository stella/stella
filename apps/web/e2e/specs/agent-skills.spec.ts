import {
  type APIRequestContext,
  type Locator,
  type Page,
  type Response,
  request as playwrightRequest,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import * as v from "valibot";

import { apiDelete, apiGet, apiStatus, E2E_API_ORIGIN } from "../helpers/api";
import { signInWithEmailOtp } from "../helpers/sign-in";
import { expect, test } from "../helpers/test";

const WEB_BASE_URL = process.env["E2E_WEB_URL"] ?? "http://localhost:3000";
const AGENT_SKILLS_TEST_TIMEOUT_MS = 180_000;

// A colleague seeded into the owner's organization with the member role
// (apps/api/scripts/seed-test-user.ts).
const MEMBER_EMAIL = "alice@stella.dev";

const SKILL_URL_PATTERN = /\/knowledge\/tools\/(?<skillId>[0-9a-f-]{36})$/u;

// The owner's seeded session always has its organization active.
const sessionSchema = v.object({
  session: v.object({ activeOrganizationId: v.string() }),
});
type SkillPayload = { slug: string };
type AuditLogPage = { items: unknown[] };

const escapeRegExp = (text: string) =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const readActiveOrganizationId = async (
  request: APIRequestContext,
): Promise<string> => {
  const response = await request.get(`${E2E_API_ORIGIN}/api/auth/get-session`);
  expect(response.ok(), await response.text()).toBe(true);
  const payload = v.parse(sessionSchema, await response.json());
  return payload.session.activeOrganizationId;
};

// Signs the member in on its own request context and activates the owner's
// organization, so a browser context built from it lands in the same org.
const signInMember = async (organizationId: string) => {
  const memberApi = await playwrightRequest.newContext({
    extraHTTPHeaders: { origin: new URL(WEB_BASE_URL).origin },
  });
  await signInWithEmailOtp(memberApi, MEMBER_EMAIL);
  const activation = await memberApi.post(
    `${E2E_API_ORIGIN}/api/auth/organization/set-active`,
    { data: { organizationId } },
  );
  expect(activation.ok(), await activation.text()).toBe(true);
  return memberApi;
};

const skillIdFromUrl = (page: Page): string => {
  const { pathname } = new URL(page.url());
  const skillId = SKILL_URL_PATTERN.exec(pathname)?.groups?.["skillId"];
  if (skillId === undefined) {
    throw new Error(`Not on a skill editor page: ${page.url()}`);
  }
  return skillId;
};

const isSkillPatch = (skillId: string) => (response: Response) =>
  response.request().method() === "PATCH" &&
  new URL(response.url()).pathname.endsWith(`/v1/skills/${skillId}`);

type CreateFromBlueprintOptions = {
  blueprint: string;
  page: Page;
  scope: "team" | "private";
};

// Opens the blueprint gallery from the Tools catalogue and lands in the new
// draft's editor. Team scope is picked in the gallery; private is its default.
const createSkillFromBlueprint = async ({
  blueprint,
  page,
  scope,
}: CreateFromBlueprintOptions): Promise<string> => {
  await page.goto("/knowledge/tools?kind=skill", { waitUntil: "commit" });
  const addCustom = page.getByRole("button", { name: "Add custom" });
  await expect(addCustom).toBeVisible({ timeout: 30_000 });
  await addCustom.click();
  await page.getByRole("menuitem", { name: "Add skill" }).click();

  const gallery = page.getByRole("dialog", {
    name: "How should your skill work?",
  });
  await expect(gallery).toBeVisible();
  const visibility = gallery.getByRole("combobox", { name: "Visibility" });
  if (scope === "team") {
    await visibility.click();
    await page.getByRole("option", { name: "Everyone in the team" }).click();
    await expect(visibility).toContainText("Everyone in the team");
  }
  await gallery
    .getByRole("button", { name: new RegExp(blueprint, "u") })
    .click();

  await expect(page).toHaveURL(SKILL_URL_PATTERN, { timeout: 30_000 });
  return skillIdFromUrl(page);
};

type CommitFieldOptions = {
  field: Locator;
  page: Page;
  skillId: string;
  value: string;
};

// The editor saves a metadata field on blur.
const commitSkillField = async ({
  field,
  page,
  skillId,
  value,
}: CommitFieldOptions) => {
  await field.fill(value);
  const saved = page.waitForResponse(isSkillPatch(skillId));
  await field.blur();
  expect((await saved).ok()).toBe(true);
};

test("a team skill is authored, used in chat, read by members, and removed", async ({
  browser,
  browserErrors,
  page,
  request,
}) => {
  test.setTimeout(AGENT_SKILLS_TEST_TIMEOUT_MS);

  const token = randomUUID().replaceAll("-", "").slice(0, 10);
  const teamSkillName = `Clause review ${token}`;
  const teamSkillDescription = `Checks clauses against house rules ${token}.`;
  const privateSkillName = `Research notes ${token}`;
  const organizationId = await readActiveOrganizationId(request);
  const memberApi = await signInMember(organizationId);
  let teamSkillId: string | null = null;
  let privateSkillId: string | null = null;

  try {
    // 1. The owner starts a team skill from a blueprint, describes it, and
    //    enables it with the editor's one enable control.
    teamSkillId = await createSkillFromBlueprint({
      blueprint: "Check against rules",
      page,
      scope: "team",
    });
    const name = page.getByRole("textbox", { name: "Name", exact: true });
    const description = page.getByRole("textbox", {
      name: "Description",
      exact: true,
    });
    const enableSkill = page.getByRole("button", { name: "Enable skill" });
    const disableSkill = page.getByRole("button", { name: "Disable skill" });
    await expect(name).toBeEditable({ timeout: 30_000 });
    await expect(page.getByText("Everyone in the team")).toBeVisible();
    await commitSkillField({
      field: name,
      page,
      skillId: teamSkillId,
      value: teamSkillName,
    });
    await commitSkillField({
      field: description,
      page,
      skillId: teamSkillId,
      value: teamSkillDescription,
    });

    const enabled = page.waitForResponse(isSkillPatch(teamSkillId));
    await enableSkill.click();
    expect((await enabled).ok()).toBe(true);
    await expect(disableSkill).toBeVisible();
    await expect(enableSkill).toHaveCount(0);

    await page.reload({ waitUntil: "commit" });
    await expect(name).toHaveValue(teamSkillName, { timeout: 30_000 });
    await expect(description).toHaveValue(teamSkillDescription);
    await expect(disableSkill).toBeVisible();

    // 2. The owner picks the skill from the composer's slash menu. The sent
    //    message carries the skill chip, and the turn loads the skill's
    //    instructions server-side: the mock model never calls load-skill, so
    //    the audit trail's skill read can only come from that preload.
    const skillReadsPath = `/audit-logs?action=access&resourceType=agent_skill&resourceId=${teamSkillId}`;
    const skillReads = async () =>
      (await apiGet<AuditLogPage>(request, skillReadsPath)).items.length;
    expect(await skillReads()).toBe(0);

    await page.goto("/chat", { waitUntil: "commit" });
    const composer = page.getByRole("textbox", {
      name: /type your question/iu,
    });
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await composer.click();
    await composer.pressSequentially(`/${token}`);
    // "/" opens the composer menu's Skills submenu; the typed text filters it.
    await page
      .getByRole("menuitem", {
        name: new RegExp(escapeRegExp(teamSkillName), "u"),
      })
      .click();
    await expect(composer).toContainText(teamSkillName);
    await composer.pressSequentially(" Review the indemnity clause.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+$/u, { timeout: 30_000 });

    const transcript = page.getByRole("log");
    const retry = transcript.getByRole("button", { name: "Retry" });
    const resend = transcript.getByRole("button", { name: "Resend" });
    await expect(transcript.getByText(teamSkillName)).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      transcript.getByText("Review the indemnity clause."),
    ).toBeVisible();
    await expect(transcript.getByText(/stella-skill-ref/u)).toHaveCount(0);
    await expect(retry).toBeVisible({ timeout: 30_000 });
    await expect(resend).toHaveCount(0);
    await expect.poll(skillReads).toBe(1);

    // A skill chip leads to the Tools catalogue with that skill's detail open.
    const { slug } = await apiGet<SkillPayload>(
      request,
      `/skills/${teamSkillId}`,
    );
    await page.goto(
      `/knowledge/tools?kind=skill&slug=${encodeURIComponent(slug)}`,
      { waitUntil: "commit" },
    );
    await expect(
      page.getByRole("heading", { name: teamSkillName, exact: true }),
    ).toBeVisible({ timeout: 30_000 });

    // 3. A member opens the team skill read-only: no enable control, and no
    //    field accepts edits.
    const memberContext = await browser.newContext({
      baseURL: WEB_BASE_URL,
      storageState: await memberApi.storageState(),
    });
    const memberPage = await memberContext.newPage();
    const detachMemberErrors = browserErrors.trackPage(memberPage);
    try {
      // Edit access reads as none until the member role loads, so wait for it
      // before asserting the controls stay absent.
      const memberRoleLoaded = memberPage.waitForResponse(
        (response) =>
          response.url().includes("/organization/get-active-member-role") &&
          response.ok(),
      );
      await memberPage.goto(`/knowledge/tools/${teamSkillId}`, {
        waitUntil: "commit",
      });
      await memberRoleLoaded;
      const memberName = memberPage.getByRole("textbox", {
        name: "Name",
        exact: true,
      });
      await expect(memberName).toHaveValue(teamSkillName, { timeout: 30_000 });
      await expect(memberName).not.toBeEditable();
      await expect(
        memberPage.getByRole("textbox", { name: "Description", exact: true }),
      ).not.toBeEditable();
      await expect(memberPage.getByText("Everyone in the team")).toBeVisible();
      await expect(
        memberPage.getByRole("button", { name: /^(Enable|Disable) skill$/u }),
      ).toHaveCount(0);

      // 4. The member starts a private skill from a blueprint; the gallery
      //    offers no team visibility, and the draft is listed for them.
      await memberPage.goto("/knowledge/tools?kind=skill", {
        waitUntil: "commit",
      });
      const memberAddCustom = memberPage.getByRole("button", {
        name: "Add custom",
      });
      await expect(memberAddCustom).toBeVisible({ timeout: 30_000 });
      await memberAddCustom.click();
      await memberPage.getByRole("menuitem", { name: "Add skill" }).click();
      const memberGallery = memberPage.getByRole("dialog", {
        name: "How should your skill work?",
      });
      const answerFromSources = memberGallery.getByRole("button", {
        name: /Answer from sources/u,
      });
      await expect(answerFromSources).toBeVisible();
      await expect(
        memberGallery.getByRole("combobox", { name: "Visibility" }),
      ).toHaveCount(0);
      await answerFromSources.click();
      await expect(memberPage).toHaveURL(SKILL_URL_PATTERN, {
        timeout: 30_000,
      });
      privateSkillId = skillIdFromUrl(memberPage);

      const privateName = memberPage.getByRole("textbox", {
        name: "Name",
        exact: true,
      });
      await expect(privateName).toBeEditable({ timeout: 30_000 });
      await expect(memberPage.getByText("Only me")).toBeVisible();
      await commitSkillField({
        field: privateName,
        page: memberPage,
        skillId: privateSkillId,
        value: privateSkillName,
      });

      await memberPage.goto("/knowledge/tools?kind=skill", {
        waitUntil: "commit",
      });
      await expect(
        memberPage.getByRole("button", {
          name: new RegExp(escapeRegExp(privateSkillName), "u"),
        }),
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      detachMemberErrors();
      await memberContext.close();
    }

    // 5. The owner removes the team skill from the catalogue, confirming first.
    await page.goto("/knowledge/tools?kind=skill", { waitUntil: "commit" });
    const teamSkillRow = page.getByRole("button", {
      name: new RegExp(escapeRegExp(teamSkillName), "u"),
    });
    await expect(teamSkillRow).toBeVisible({ timeout: 30_000 });
    await teamSkillRow.getByRole("button", { name: "Remove" }).click();
    const confirmation = page.getByRole("alertdialog");
    await expect(confirmation).toContainText(teamSkillName);
    await confirmation.getByRole("button", { name: "Remove" }).click();
    await expect(teamSkillRow).toHaveCount(0);
    await expect
      .poll(async () => await apiStatus(request, `/skills/${teamSkillId}`))
      .toBe(404);
    teamSkillId = null;
  } finally {
    if (privateSkillId !== null) {
      await apiDelete(memberApi, `/skills/${privateSkillId}`);
    }
    if (teamSkillId !== null) {
      await apiDelete(request, `/skills/${teamSkillId}`);
    }
    await memberApi.dispose();
  }
});
