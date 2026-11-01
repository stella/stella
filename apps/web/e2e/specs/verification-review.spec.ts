import { PDF } from "@libpdf/core";
import type { APIRequestContext, Page } from "@playwright/test";

import { apiGet } from "../helpers/api";
import { waitForStableGeometry } from "../helpers/stable-geometry";
import { expect, test } from "../helpers/test";
import { createTestWorkspace, deleteTestWorkspace } from "../helpers/workspace";
import type { TestWorkspace } from "../helpers/workspace";

// The web's verification types reach the generated route tree, which the E2E
// project does not compile, so this journey states its wire fixtures directly.
type ViewSummary = { id: string; name: string; layout: unknown };
type OrganizationSettingsSummary = {
  declaredFeatureIds: string[];
  capabilities: Record<string, unknown>;
};

const uuid = (suffix: number) =>
  `0199a3c4-5b6d-7e8f-9a0b-${String(suffix).padStart(12, "0")}`;
const governingFactId = uuid(5);
const competingFactId = uuid(6);
const emptyReview = {
  status: null,
  statusOrigin: null,
  override: null,
  note: "",
  noteSavedAt: null,
  decidedAt: null,
  decidedBy: null,
  reopened: false,
  recordConflictResolution: null,
};
const avtLayout = {
  version: 1,
  type: "avt",
  filters: [],
  sorts: [],
  hiddenProperties: [],
  calculations: [],
  listId: null,
};
const fact = (factEntityId: string, text: string) => ({
  factEntityId,
  text,
  occurredOn: null,
  occurredOnPrecision: null,
  evidenceKind: null,
  medium: null,
  confidence: "high",
  interpretationNote: null,
  sources: [],
});

/**
 * A real seeded matter supplies auth and permission chrome; its view is shown
 * as a verification view, with list verification switched on.
 */
const enableVerification = async (
  page: Page,
  request: APIRequestContext,
  workspace: TestWorkspace,
) => {
  const views = await apiGet<ViewSummary[]>(request, `/views/${workspace.id}`);
  const settings = await apiGet<OrganizationSettingsSummary>(
    request,
    "/organization-settings",
  );
  const { cookies } = await request.storageState();
  await page.context().addCookies(cookies);
  await page.route("**/v1/organization-settings", async (route) => {
    await route.fulfill({
      json: {
        ...settings,
        declaredFeatureIds: [
          ...settings.declaredFeatureIds,
          "list-verification",
          "legal-lists",
        ],
        capabilities: {
          ...settings.capabilities,
          "list-verification": { status: "enabled" },
          "legal-lists": { status: "enabled" },
        },
      } satisfies OrganizationSettingsSummary,
    });
  });
  await page.route(`**/v1/views/${workspace.id}*`, async (route) => {
    await route.fulfill({
      json: views.map((view) =>
        view.id === workspace.viewId
          ? { ...view, name: "Verification", layout: avtLayout }
          : view,
      ),
    });
  });
};

test("a reviewer reconciles conflicting records, confirms the verdict, and reloads", async ({
  page,
  request,
}) => {
  const workspace = await createTestWorkspace(request, "verification-review");
  try {
    await enableVerification(page, request, workspace);
    const text = "The drawdown occurred on 5 July 2021.";
    const claim = {
      id: uuid(1001),
      position: 1,
      type: "fact",
      framing: "asserted",
      verdict: {
        state: "recordconflict",
        score: null,
        recordConflict: {
          subject: "Date of the drawdown",
          factEntityIds: [governingFactId, competingFactId],
          values: ["5 July 2021", "28 July 2021"],
          governingStates: ["supported", "contradicted"],
        },
      },
      text,
      anchor: { type: "docx-block", blockId: "b1", start: 0, end: text.length },
      refs: [],
    };
    const run = {
      id: uuid(9000),
      entityId: uuid(9001),
      fileFieldId: uuid(9002),
      entityVersionId: uuid(9003),
      evidence: {
        listId: uuid(9004),
        facts: [
          fact(governingFactId, "The bank ledger records 5 July 2021."),
          fact(competingFactId, "The payment notice records 28 July 2021."),
        ],
      },
      status: "completed",
      errorCode: null,
      pipelineVersion: 1,
      modelRef: null,
      requestedBy: null,
      blocks: [
        {
          ordinal: 0,
          blockId: "b1",
          kind: "docx-block",
          pageNumber: null,
          text,
        },
      ],
      createdAt: "2026-09-01T09:00:00.000Z",
      startedAt: "2026-09-01T09:00:01.000Z",
      finishedAt: "2026-09-01T09:01:00.000Z",
    };
    let review: Record<string, unknown> | null = null;
    let reviewWrites = 0;
    const forbiddenRequests: string[] = [];

    // All list and verification traffic is intercepted, including unexpected
    // starts, so this browser journey cannot enqueue a model-backed
    // verification.
    await page.route("**/v1/lists/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const root = `/v1/lists/${workspace.id}`;
      if (route.request().method() === "GET" && path === root) {
        await route.fulfill({ json: { items: [], nextCursor: null } });
        return;
      }
      if (
        route.request().method() === "GET" &&
        path === `${root}/verifications/${run.id}`
      ) {
        await route.fulfill({
          json: { ...run, claims: [{ ...claim, review }] },
        });
        return;
      }
      if (
        route.request().method() === "GET" &&
        path === `${root}/verifications`
      ) {
        await route.fulfill({ json: { items: [], nextCursor: null } });
        return;
      }
      // The claim detail panel lists the claim's comments; this journey has none.
      if (
        route.request().method() === "GET" &&
        path === `${root}/claim-comments`
      ) {
        await route.fulfill({ json: { items: [], nextCursor: null } });
        return;
      }
      if (
        route.request().method() === "POST" &&
        path === `${root}/claim-reviews`
      ) {
        const event =
          reviewWrites === 0
            ? {
                kind: "record-conflict",
                resolution: { kind: "governed", factEntityId: governingFactId },
              }
            : { kind: "status", status: "reviewed" };
        expect(route.request().postDataJSON()).toEqual({
          runId: run.id,
          claimId: claim.id,
          event,
        });
        reviewWrites += 1;
        review = {
          ...emptyReview,
          decidedAt: "2026-09-01T10:00:00.000Z",
          decidedBy: "0199a3c4-5b6d-7e8f-9a0b-000000009005",
          recordConflictResolution: {
            kind: "governed",
            factEntityId: governingFactId,
          },
          ...(reviewWrites === 2
            ? ({ status: "reviewed", statusOrigin: "single" } as const)
            : {}),
        };
        await route.fulfill({ json: { claimId: claim.id, review } });
        return;
      }
      forbiddenRequests.push(`${route.request().method()} ${path}`);
      await route.fulfill({
        status: 400,
        json: { message: "Unexpected verification request" },
      });
    });

    await page.goto(
      `/workspaces/${workspace.id}/${workspace.viewId}?run=${run.id}`,
      { waitUntil: "commit" },
    );
    await expect(
      page.getByText("Verdict withheld", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("The bank ledger records 5 July 2021.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("The payment notice records 28 July 2021.", {
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Treat as governing", exact: true })
      .first()
      .click();
    await expect(
      page.getByText("5 July 2021 governs:", { exact: false }),
    ).toBeVisible();
    // Resolving the record changes the displayed disposition while preserving
    // the tool's original withheld score and both underlying records.
    await expect(
      page.getByText("Verdict withheld", { exact: true }),
    ).toBeVisible();
    const confirmation = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          `/v1/lists/${workspace.id}/claim-reviews` &&
        (response.request().postData() ?? "").includes('"kind":"status"'),
    );
    await page
      .getByRole("button", { name: "Confirm — ready", exact: true })
      .click();
    expect((await confirmation).ok()).toBe(true);
    // The response alone does not prove the client applied it; reload only
    // once the product shows the save as complete.
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    expect(reviewWrites).toBe(2);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.getByText("5 July 2021 governs:", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Undo decision", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("The payment notice records 28 July 2021.", {
        exact: true,
      }),
    ).toBeVisible();
    expect(reviewWrites).toBe(2);
    expect(forbiddenRequests).toEqual([]);
  } finally {
    await deleteTestWorkspace(request, workspace.id);
  }
});

test("the original PDF draws each claim's box, selects a claim by its box, and brings a claim on a later page into view", async ({
  page,
  request,
}) => {
  const workspace = await createTestWorkspace(request, "verification-pdf");
  try {
    await enableVerification(page, request, workspace);
    const signedText = "The parties signed the agreement in July.";
    const depositText = "The buyer paid the deposit on 3 August.";
    const deliveredText = "The seller delivered the goods in March.";
    const pdf = PDF.create();
    const first = pdf.addPage({ size: "letter" });
    first.drawText(signedText, { x: 72, y: 700, size: 12 });
    first.drawText(depositText, { x: 72, y: 660, size: 12 });
    // At the foot of the second page, out of view until it is brought there.
    pdf
      .addPage({ size: "letter" })
      .drawText(deliveredText, { x: 72, y: 72, size: 12 });
    const bytes = await pdf.save();
    const pageOneText = `${signedText}\n${depositText}`;
    const pageTexts = new Map([
      [1, pageOneText],
      [2, deliveredText],
    ]);
    const pdfClaim = ({
      id,
      position,
      state,
      text,
      pageNumber,
    }: {
      id: string;
      position: number;
      state: "supported" | "contradicted";
      text: string;
      pageNumber: number;
    }) => {
      const start = (pageTexts.get(pageNumber) ?? "").indexOf(text);
      return {
        id,
        position,
        type: "fact",
        framing: "asserted",
        verdict: {
          state,
          score: state === "supported" ? 90 : 10,
          recordConflict: null,
        },
        text,
        anchor: {
          type: "pdf-page",
          pageNumber,
          start,
          end: start + text.length,
        },
        refs: [],
        review: null,
      };
    };
    const signed = pdfClaim({
      id: uuid(2001),
      position: 1,
      state: "supported",
      text: signedText,
      pageNumber: 1,
    });
    const deposit = pdfClaim({
      id: uuid(2002),
      position: 2,
      state: "contradicted",
      text: depositText,
      pageNumber: 1,
    });
    const delivered = pdfClaim({
      id: uuid(2003),
      position: 3,
      state: "contradicted",
      text: deliveredText,
      pageNumber: 2,
    });
    const run = {
      id: uuid(9100),
      entityId: uuid(9101),
      fileFieldId: uuid(9102),
      entityVersionId: uuid(9103),
      evidence: { listId: uuid(9104), facts: [] },
      status: "completed",
      errorCode: null,
      pipelineVersion: 1,
      modelRef: null,
      requestedBy: null,
      blocks: [
        {
          ordinal: 0,
          blockId: "p1",
          kind: "pdf-page",
          pageNumber: 1,
          text: pageOneText,
        },
        {
          ordinal: 1,
          blockId: "p2",
          kind: "pdf-page",
          pageNumber: 2,
          text: deliveredText,
        },
      ],
      claims: [signed, deposit, delivered],
      createdAt: "2026-09-01T09:00:00.000Z",
      startedAt: "2026-09-01T09:00:01.000Z",
      finishedAt: "2026-09-01T09:01:00.000Z",
    };
    const forbiddenRequests: string[] = [];

    // The verified file is served from the test, through the same presigned
    // URL hop the viewer takes for a stored upload.
    const pdfPath = "/v1/e2e-verified-original.pdf";
    await page.route(
      `**/v1/files/${workspace.id}/url/${run.fileFieldId}*`,
      async (route) => {
        await route.fulfill({
          json: {
            fileId: uuid(9105),
            fileName: "statement.pdf",
            mimeType: "application/pdf",
            originalMimeType: "application/pdf",
            presignedUrl: new URL(pdfPath, route.request().url()).href,
          },
        });
      },
    );
    await page.route(`**${pdfPath}`, async (route) => {
      await route.fulfill({
        body: Buffer.from(bytes),
        contentType: "application/pdf",
      });
    });
    await page.route("**/v1/lists/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const root = `/v1/lists/${workspace.id}`;
      const isGet = route.request().method() === "GET";
      if (
        isGet &&
        (path === root ||
          path === `${root}/verifications` ||
          path === `${root}/claim-comments`)
      ) {
        await route.fulfill({ json: { items: [], nextCursor: null } });
        return;
      }
      if (isGet && path === `${root}/verifications/${run.id}`) {
        await route.fulfill({ json: run });
        return;
      }
      forbiddenRequests.push(`${route.request().method()} ${path}`);
      await route.fulfill({
        status: 400,
        json: { message: "Unexpected verification request" },
      });
    });

    const box = (claim: { id: string }) =>
      page.locator(`[data-avt-claim="${claim.id}"]`).first();
    const detail = (claim: { text: string }) =>
      page.locator("blockquote").filter({ hasText: claim.text });

    await page.goto(
      `/workspaces/${workspace.id}/${workspace.viewId}?run=${run.id}`,
      { waitUntil: "commit" },
    );
    await page.getByRole("tab", { name: "Original", exact: true }).click();

    // A box sits over the words it was drawn for: the middle of a word of
    // the claim, as the page's text layer lays it out, falls inside the box.
    // The page renders its text layer after the canvas and the boxes, so the
    // check waits for both to appear and settle before it measures.
    const expectBoxOverWord = async (claim: { id: string }, word: string) => {
      const drawn = box(claim);
      const text = page
        .locator("[data-text-layer] span")
        .filter({ hasText: word })
        .first();
      await expect(drawn).toBeVisible();
      await expect(text).toBeVisible();
      await waitForStableGeometry(page, [drawn, text]);
      await expect
        .poll(
          async () => {
            const [outer, inner] = await Promise.all([
              drawn.boundingBox(),
              text.boundingBox(),
            ]);
            if (outer === null || inner === null) {
              return false;
            }
            const x = inner.x + inner.width / 2;
            const y = inner.y + inner.height / 2;
            return (
              x >= outer.x &&
              x <= outer.x + outer.width &&
              y >= outer.y &&
              y <= outer.y + outer.height
            );
          },
          { message: `The box is not drawn over the text of "${word}"` },
        )
        .toBe(true);
    };

    // The first claim is selected and drawn over the words it was read from.
    await expect(box(signed)).toBeVisible();
    await expect(box(signed)).toHaveAttribute("data-active", "true");
    await expect(detail(signed)).toBeVisible();
    await expectBoxOverWord(signed, "signed");

    // A click on another claim's box selects that claim.
    await box(deposit).click();
    await expect(box(deposit)).toHaveAttribute("data-active", "true");
    await expect(detail(deposit)).toBeVisible();

    // Stepping to the next contradicted claim brings its box, on the second
    // page, into view.
    await page
      .getByRole("button", { name: /Contradicted/u })
      .first()
      .click();
    await page
      .getByRole("button", { name: "Next match", exact: true })
      .first()
      .click();
    await expect(detail(delivered)).toBeVisible();
    await expect(box(delivered)).toHaveAttribute("data-active", "true");
    await expect(box(delivered)).toBeInViewport();
    await expectBoxOverWord(delivered, "delivered");
    expect(forbiddenRequests).toEqual([]);
  } finally {
    await deleteTestWorkspace(request, workspace.id);
  }
});
