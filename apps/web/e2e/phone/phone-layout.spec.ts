import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { apiPut } from "../helpers/api";
import { ROUTE_ERROR_HEADING } from "../helpers/app-shell";
import { createTestCorrespondence } from "../helpers/correspondence";
import {
  E2E_CLEANUP_TARGET_TYPE,
  registerDeferredE2eCleanup,
} from "../helpers/deferred-cleanup";
import { createUploadedDocumentRoute } from "../helpers/document";
import { createNetworkCollector } from "../helpers/network";
import { findPhoneLayoutProblems } from "../helpers/phone-layout";
import {
  SMOKE_ROUTE_DEFS,
  type SmokeRouteDef,
  type SmokeWorld,
} from "../helpers/smoke-route-defs";
import { createTestWorkspace } from "../helpers/workspace";

// Walks the route smoke table on the narrowest current iPhone (see
// playwright.phone.config.ts) and holds every page to the phone layout rules.
// Redirect aliases are skipped: each target is its own entry in the table.

const NETWORK_QUIET_MS = 500;
const DEFAULT_SETTLE_MS = 1000;

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const STORAGE_STATE = path.resolve(REPO_ROOT, ".playwright/storage-state.json");

const PHONE_ROUTE_DEFS = SMOKE_ROUTE_DEFS.filter(
  (def) => def.expectation?.kind !== "redirectsTo",
);

test.describe.serial("pages fit a phone", () => {
  let apiRequest: APIRequestContext;
  let world: SmokeWorld | null = null;

  test.beforeAll(async ({ playwright }, testInfo) => {
    apiRequest = await playwright.request.newContext({
      storageState: STORAGE_STATE,
    });
    const workspace = await createTestWorkspace(apiRequest, "phone-layout");
    await registerDeferredE2eCleanup(testInfo.project.outputDir, {
      type: E2E_CLEANUP_TARGET_TYPE.WORKSPACE,
      id: workspace.id,
    });
    const contactId = randomUUID();
    await apiPut(apiRequest, "/contacts", {
      id: contactId,
      type: "person",
      displayName: `Phone Layout ${contactId.slice(0, 8)}`,
      firstName: "Phone",
      lastName: "Layout",
    });
    await registerDeferredE2eCleanup(testInfo.project.outputDir, {
      type: E2E_CLEANUP_TARGET_TYPE.CONTACT,
      id: contactId,
    });
    const documentRoute = await createUploadedDocumentRoute({
      fileName: "phone-layout.docx",
      request: apiRequest,
      workspace,
    });
    const correspondenceId = await createTestCorrespondence(workspace.id);
    world = { workspace, contactId, documentRoute, correspondenceId };
  });

  test.afterAll(async () => {
    await apiRequest.dispose();
  });

  test("the browser reports a touch screen", async ({ page }) => {
    // Without these the touch rules (hover-only controls, enlarged hit
    // areas) would be checked against a desktop pointer.
    await page.goto("/workspaces", { waitUntil: "domcontentloaded" });
    expect(
      await page.evaluate(() => ({
        coarse: matchMedia("(pointer: coarse)").matches,
        hover: matchMedia("(hover: hover)").matches,
      })),
    ).toEqual({ coarse: true, hover: false });
  });

  const declareRouteTest = (def: SmokeRouteDef) => {
    test(def.template, async ({ page }) => {
      if (world === null) {
        throw new Error("phone-layout world was not initialized in beforeAll");
      }
      const network = createNetworkCollector();
      const detachNetwork = network.trackPage(page);
      try {
        await page.goto(def.path(world), { waitUntil: "domcontentloaded" });
        await expect(page).not.toHaveURL(/\/auth(?:\/|$)/u);
        await expect(page.locator("main").first()).toBeVisible({
          timeout: 30_000,
        });
        await network.waitForQuiet({
          idleMs: NETWORK_QUIET_MS,
          minimumObservationMs: DEFAULT_SETTLE_MS,
          timeoutMs: Math.max(def.settleMs ?? DEFAULT_SETTLE_MS, 10_000),
        });
        await expect(
          page.getByRole("heading", { name: ROUTE_ERROR_HEADING }),
        ).toHaveCount(0);
        expect(
          await findPhoneLayoutProblems(page),
          `${def.template} breaks the phone layout rules`,
        ).toEqual([]);
      } finally {
        detachNetwork();
      }
    });
  };
  for (const def of PHONE_ROUTE_DEFS) {
    declareRouteTest(def);
  }
});
