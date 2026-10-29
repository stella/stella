import type { Page, Route } from "@playwright/test";
import { panic } from "better-result";

import { apiStatus, apiUploadDocx } from "../helpers/api";
import { expect, test } from "../helpers/test";
import {
  createTestWorkspace,
  deleteTestWorkspace,
  type TestWorkspace,
} from "../helpers/workspace";

const PDF_MIME = "application/pdf";
const FILE_NAME = "save-and-sign.pdf";
const SIGN_LABEL = "Sign with stella desktop";
const PLACEMENT_LABEL = "Sign PDF";
const HANDOFF_ROUTE = "**/v1/entities/*/pdf-signing-handoffs";

type HandoffBody = {
  entityId: string;
  fieldId: string;
  propertyId: string;
};

const buildMultiPagePdf = (): Buffer => {
  const pageOne = "BT /F1 18 Tf 72 720 Td (First page) Tj ET";
  const pageTwo = "BT /F1 18 Tf 72 720 Td (Second page) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${String(Buffer.byteLength(pageOne))} >>\nstream\n${pageOne}\nendstream`,
    `<< /Length ${String(Buffer.byteLength(pageTwo))} >>\nstream\n${pageTwo}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body);
  const xrefRows = offsets.map(
    (offset) => `${String(offset).padStart(10, "0")} 00000 n \n`,
  );
  body += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n${xrefRows.join("")}`;
  body += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
};

const currentDesktop = {
  type: "current",
  desktop: {
    version: "1.0.0",
    protocol: 1,
    lastSeenAt: "2026-01-01T00:00:00.000Z",
  },
};

const holdHandoffs = async (page: Page) => {
  const requests: HandoffBody[] = [];
  const routes: Route[] = [];
  await page.route(HANDOFF_ROUTE, async (route) => {
    requests.push(route.request().postDataJSON() as HandoffBody);
    routes.push(route);
  });
  return { requests, routes };
};

const releaseHandoff = async (route: Route) => {
  await route.fulfill({
    json: {
      deepLinkUrl: "stella://pdf-sign/open?handoff=e2e",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      sessionId: "90123344-5566-7788-9900-aabbccddeeff",
    },
  });
};

const viewerSignControl = (page: Page) =>
  page
    .getByRole("button", { name: "Edit pages" })
    .locator("..")
    .getByRole("button", { name: SIGN_LABEL });

const organizerSignControl = (page: Page) =>
  page
    .getByRole("list", { name: "PDF pages" })
    .locator("xpath=ancestor::div[footer]")
    .getByRole("button", { name: SIGN_LABEL });

test.describe("PDF save and sign on the document route", () => {
  let workspace: TestWorkspace | null = null;

  test.beforeEach(async ({ request }) => {
    workspace = await createTestWorkspace(request, "pdf-save-and-sign");
  });

  test.afterEach(async ({ page, request }, testInfo) => {
    if (workspace === null) {
      return;
    }
    await deleteTestWorkspace(request, workspace.id, {
      leave: { page, testInfo },
    });
    workspace = null;
  });

  const openDocument = async (page: Page, request: Page["request"]) => {
    const testWorkspace = workspace;
    if (testWorkspace === null) {
      panic("Test workspace was not created");
    }
    const uploaded = await apiUploadDocx(
      request,
      testWorkspace.id,
      testWorkspace.filePropertyId,
      { name: FILE_NAME, mimeType: PDF_MIME, buffer: buildMultiPagePdf() },
    );
    const { cookies } = await request.storageState();
    await page.context().addCookies(cookies);
    await page.route("**/v1/desktop/presence", async (route) => {
      await route.fulfill({ json: currentDesktop });
    });
    await expect
      .poll(
        async () =>
          await apiStatus(page.request, `/workspaces/${testWorkspace.id}`),
        { timeout: 10_000 },
      )
      .toBe(200);
    await page.goto(
      `/workspaces/${testWorkspace.id}/${testWorkspace.viewId}/document?entity=${uploaded.entityId}&field=${uploaded.fieldId}`,
      { waitUntil: "domcontentloaded" },
    );
    await expect(page.locator("[data-text-layer]").first()).toBeVisible({
      timeout: 45_000,
    });
    await expect(viewerSignControl(page)).toBeVisible({
      timeout: 45_000,
    });
    return { originalFieldId: uploaded.fieldId };
  };

  const openOrganizer = async (page: Page) => {
    await page.getByRole("button", { name: "Edit pages" }).click();
    await expect(page.getByRole("list", { name: "PDF pages" })).toBeVisible();
  };

  const rotateFirstPage = async (page: Page) => {
    await page.getByRole("checkbox", { name: "Select page 1" }).click();
    await page.getByRole("button", { name: "Rotate right" }).click();
    await expect(page.getByRole("article", { name: "Page 1" })).toContainText(
      "90°",
    );
  };

  const placeAndConfirm = async (page: Page) => {
    const placement = page.getByRole("group", { name: PLACEMENT_LABEL });
    await expect(placement).toBeVisible();
    await placement.getByRole("button", { name: "Place on last page" }).click();
    await placement.getByRole("button", { name: "Sign with stamp" }).click();
    await expect(placement).toBeHidden();
  };

  test("dirty save-and-sign advances and hands off the saved version", async ({
    page,
    request,
  }) => {
    const { originalFieldId } = await openDocument(page, request);
    const handoffs = await holdHandoffs(page);

    await openOrganizer(page);
    await rotateFirstPage(page);
    await organizerSignControl(page).click();

    await expect(page.getByRole("list", { name: "PDF pages" })).toBeHidden();
    await expect(
      page.getByRole("group", { name: PLACEMENT_LABEL }),
    ).toBeVisible();
    await expect(page).not.toHaveURL(
      new RegExp(`field=${originalFieldId}(?:&|$)`, "u"),
    );
    await placeAndConfirm(page);
    await expect.poll(() => handoffs.requests.length).toBe(1);
    expect(handoffs.requests[0]?.fieldId).not.toBe(originalFieldId);
    expect(page.url()).toContain(
      `field=${handoffs.requests[0]?.fieldId ?? ""}`,
    );
  });

  test("switching versions revokes a held handoff", async ({
    page,
    request,
  }) => {
    const { originalFieldId } = await openDocument(page, request);
    await openOrganizer(page);
    await rotateFirstPage(page);
    await page.getByRole("button", { name: "Save version" }).click();
    await expect(
      page.getByText("Version saved", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("list", { name: "PDF pages" })).toBeHidden();

    const handoffs = await holdHandoffs(page);
    await viewerSignControl(page).click();
    await placeAndConfirm(page);
    await expect.poll(() => handoffs.routes.length).toBe(1);

    await page.getByRole("button", { name: "Version history" }).click();
    await page.getByRole("button", { name: "v1" }).click();
    await expect(page).toHaveURL(
      new RegExp(`field=${originalFieldId}(?:&|$)`, "u"),
    );
    await releaseHandoff(handoffs.routes[0] ?? panic("Handoff route missing"));

    await expect.poll(() => handoffs.requests.length).toBe(1);
    await expect(
      page.getByRole("group", { name: PLACEMENT_LABEL }),
    ).toBeHidden();
    expect(page.url()).not.toContain("stella://");
  });

  test("clean sign hands off the open version", async ({ page, request }) => {
    const { originalFieldId } = await openDocument(page, request);
    const handoffs = await holdHandoffs(page);

    await viewerSignControl(page).click();
    await placeAndConfirm(page);

    await expect.poll(() => handoffs.requests.length).toBe(1);
    expect(handoffs.requests[0]?.fieldId).toBe(originalFieldId);
  });
});
