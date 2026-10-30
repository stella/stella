import { panic } from "better-result";

import { apiStatus, apiUploadDocx } from "../helpers/api";
import { expect, test } from "../helpers/test";
import {
  createTestWorkspace,
  deleteTestWorkspace,
  type TestWorkspace,
} from "../helpers/workspace";

const PDF_MIME = "application/pdf";
const FILE_NAME = "inspector-selection.pdf";

const LINES = [
  "Article 1 Definitions",
  "Article 2 Scope of the agreement",
  "Article 3 Term and termination",
  "Article 4 Governing law",
  "Article 5 Notices",
] as const;

/**
 * Holding the pointer down for this long spans several fit-to-width redraw
 * delays (150 ms), so a viewer that redraws its pages while idle replaces the
 * text layer under the selection before the drag ends.
 */
const POINTER_HOLD_MS = 1000;

const escapePdfString = (text: string) => text.replace(/[\\()]/gu, "\\$&");

/** A one-page PDF with one Helvetica text run per line. */
const buildTextPdf = (lines: readonly string[]): Buffer => {
  const runs = lines.map((line) => `(${escapePdfString(line)}) Tj T*`);
  const content = `BT /F1 14 Tf 72 720 Td 24 TL ${runs.join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${String(Buffer.byteLength(content))} >>\nstream\n${content}\nendstream`,
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

test.describe("PDF preview in the inspector", () => {
  let workspace: TestWorkspace | null = null;

  test.beforeEach(async ({ request }) => {
    workspace = await createTestWorkspace(request, "inspector-pdf-selection");
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

  test("a held drag selects only the dragged lines", async ({
    page,
    request,
  }) => {
    const testWorkspace = workspace;
    if (testWorkspace === null) {
      panic("Test workspace was not created");
    }

    await apiUploadDocx(
      request,
      testWorkspace.id,
      testWorkspace.filePropertyId,
      { name: FILE_NAME, mimeType: PDF_MIME, buffer: buildTextPdf(LINES) },
    );

    const { cookies } = await request.storageState();
    await page.context().addCookies(cookies);
    await expect
      .poll(
        async () =>
          await apiStatus(page.request, `/workspaces/${testWorkspace.id}`),
        { timeout: 10_000 },
      )
      .toBe(200);

    await page.goto(`/workspaces/${testWorkspace.id}/${testWorkspace.viewId}`, {
      waitUntil: "domcontentloaded",
    });
    const tableTab = page.getByRole("tab", { exact: true, name: "Table" });
    await expect(tableTab).toBeVisible({ timeout: 30_000 });
    await tableTab.click();
    const fileButton = page
      .locator('[data-slot="workspace-grid-cell"]')
      .getByRole("button", { exact: true, name: FILE_NAME });
    await expect(fileButton).toBeVisible({ timeout: 30_000 });
    await fileButton.click();

    const textLayer = page.locator(
      '[data-slot="inspector-dock"] [data-text-layer]',
    );
    const startRun = textLayer.locator("span", { hasText: LINES[1] });
    const endRun = textLayer.locator("span", { hasText: LINES[2] });
    await expect(startRun).toBeVisible({ timeout: 45_000 });
    await expect(endRun).toBeVisible();

    const startBox = await startRun.boundingBox();
    const endBox = await endRun.boundingBox();
    if (startBox === null || endBox === null) {
      panic("The text layer runs have no layout box");
    }
    const startY = startBox.y + startBox.height / 2;
    const endY = endBox.y + endBox.height / 2;

    await page.mouse.move(startBox.x + 1, startY);
    await page.mouse.down();
    await page.mouse.move(startBox.x + startBox.width / 2, startY, {
      steps: 5,
    });
    // real-time: the defect is a redraw on a timer while the pointer is held.
    await page.waitForTimeout(POINTER_HOLD_MS);
    await page.mouse.move(endBox.x + endBox.width - 1, endY, { steps: 5 });
    await page.mouse.up();

    const selected = await page.evaluate(
      () => document.getSelection()?.toString() ?? "",
    );
    expect(selected).toContain(LINES[1]);
    expect(selected).toContain(LINES[2].slice(0, -1));
    expect(selected).not.toContain(LINES[0]);
    expect(selected).not.toContain(LINES[3]);
  });
});
