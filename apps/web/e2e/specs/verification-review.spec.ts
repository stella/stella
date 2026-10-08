import {
  factId,
  makeClaim,
  makeFact,
  makeRun,
  recordConflict,
} from "../../src/features/avt/avt.test-fixtures";
import { EMPTY_CLAIM_REVIEW } from "../../src/features/avt/claim-review.logic";
import type {
  ClaimReview,
  VerificationRun,
} from "../../src/features/avt/types";
import type { WorkspaceView } from "../../src/lib/types";
import { EMPTY_AVT_LAYOUT } from "../../src/lib/workspaces/view-layout";
import type { OrganizationSettings } from "../../src/queries/organization-settings";
import { apiGet } from "../helpers/api";
import { expect, test } from "../helpers/test";
import { createTestWorkspace, deleteTestWorkspace } from "../helpers/workspace";

test("a reviewer reconciles conflicting records, confirms the verdict, and reloads", async ({
  page,
  request,
}) => {
  const workspace = await createTestWorkspace(request, "verification-review");
  try {
    const views = await apiGet<WorkspaceView[]>(
      request,
      `/views/${workspace.id}`,
    );
    const settings = await apiGet<OrganizationSettings>(
      request,
      "/organization-settings",
    );
    const { cookies } = await request.storageState();
    await page.context().addCookies(cookies);
    const text = "The drawdown occurred on 5 July 2021.";
    const claim = {
      ...makeClaim({ suffix: 1, verdict: recordConflict }),
      text,
      anchor: { type: "docx-block", blockId: "b1", start: 0, end: text.length },
    } as const satisfies VerificationRun["claims"][number];
    const run = {
      ...makeRun(
        [claim],
        [
          makeFact(5, { text: "The bank ledger records 5 July 2021." }),
          makeFact(6, { text: "The payment notice records 28 July 2021." }),
        ],
      ),
      blocks: [
        {
          ordinal: 0,
          blockId: "b1",
          kind: "docx-block",
          pageNumber: null,
          text,
        },
      ],
    } as const satisfies VerificationRun;
    let review: ClaimReview | null = null;
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
        } satisfies OrganizationSettings,
      });
    });
    await page.route(`**/v1/views/${workspace.id}*`, async (route) => {
      await route.fulfill({
        json: views.map((view) =>
          view.id === workspace.viewId
            ? { ...view, name: "Verification", layout: EMPTY_AVT_LAYOUT }
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
                resolution: { kind: "governed", factEntityId: factId(5) },
              }
            : { kind: "status", status: "reviewed" };
        expect(route.request().postDataJSON()).toEqual({
          runId: run.id,
          claimId: claim.id,
          event,
        });
        reviewWrites += 1;
        review = {
          ...EMPTY_CLAIM_REVIEW,
          decidedAt: "2026-09-01T10:00:00.000Z",
          decidedBy: "0199a3c4-5b6d-7e8f-9a0b-000000009005",
          recordConflictResolution: {
            kind: "governed",
            factEntityId: factId(5),
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
    await page
      .getByRole("button", { name: "Confirm — ready", exact: true })
      .click();
    await expect.poll(() => reviewWrites).toBe(2);
    await page.reload();
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
