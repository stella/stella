// Shared by the landing screenshot spec and the video recorder. Opening the
// seeded Supplier Agreement with `?editing=true` starts an edit session: a
// lease-backed lock that file lists show as a lock badge with the editor's
// avatar. A full navigation or a closed page never unmounts the editor, so the
// session outlives the shot that opened it and badges the document in every
// later scene until the lease expires. Both tools release it explicitly and
// check that scenes which should show no lock show none.
import type { APIRequestContext, Page } from "@playwright/test";

import type { SupplierAgreementIds } from "./seed-ids";

/** The editor route that opens the Supplier Agreement and takes its lock. */
export const supplierAgreementEditorPath = ({
  workspaceId,
  entityId,
  fieldId,
}: SupplierAgreementIds) =>
  `/workspaces/${workspaceId}/all/document` +
  "?editing=true" +
  `&entity=${entityId}` +
  `&field=${fieldId}`;

type ReleaseEditLockOptions = {
  apiUrl: string;
  webUrl: string;
  supplierAgreement: SupplierAgreementIds;
};

/**
 * Cancel the signed-in user's live edit session on the Supplier Agreement,
 * if any (apps/api/src/handlers/entities/release-desktop-edit-lock.ts); a
 * no-op when none is open. `request` must carry the session cookies.
 */
export const releaseSupplierAgreementEditLock = async (
  request: APIRequestContext,
  { apiUrl, webUrl, supplierAgreement }: ReleaseEditLockOptions,
) => {
  const response = await request.post(
    `${apiUrl}/v1/entities/${supplierAgreement.workspaceId}/desktop-edit-sessions/release`,
    {
      data: {
        entityId: supplierAgreement.entityId,
        propertyId: supplierAgreement.propertyId,
      },
      headers: { origin: new URL(webUrl).origin },
    },
  );
  if (!response.ok()) {
    throw new Error(
      `Could not release the Supplier Agreement edit lock: ${await response.text()}`,
    );
  }
};

/**
 * Fail when any document in the page carries an edit-lock badge. Call once
 * the scene's rows have rendered, since badges arrive with them.
 */
export const assertNoActiveEditBadge = async (page: Page, scene: string) => {
  const badges = await page.locator('[data-slot="active-edit-badge"]').count();
  if (badges > 0) {
    throw new Error(
      `${scene}: ${String(badges)} document(s) show an edit-lock badge; an ` +
        "earlier editor scene left its edit session open",
    );
  }
};
