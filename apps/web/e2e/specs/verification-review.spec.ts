import { apiGet } from "../helpers/api";
import { expect, test } from "../helpers/test";
import { createTestWorkspace, deleteTestWorkspace } from "../helpers/workspace";

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

test("a reviewer reconciles conflicting records, confirms the verdict, and reloads", async ({
  page,
  request,
}) => {
  const workspace = await createTestWorkspace(request, "verification-review");
  try {
    const views = await apiGet<ViewSummary[]>(
      request,
      `/views/${workspace.id}`,
    );
    const settings = await apiGet<OrganizationSettingsSummary>(
      request,
      "/organization-settings",
    );
    const { cookies } = await request.storageState();
    await page.context().addCookies(cookies);
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

    // A real seeded matter supplies auth and permission chrome. All list and
    // verification traffic is intercepted, including unexpected starts, so
    // this browser journey cannot enqueue a model-backed verification.
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
