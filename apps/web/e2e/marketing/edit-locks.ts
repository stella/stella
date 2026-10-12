// Shared by the landing screenshot spec and the video recorder. Opening the
// seeded Supplier Agreement with `?editing=true` starts an edit session: a
// lease-backed lock that file lists show as a lock badge with the editor's
// avatar. A full navigation or a closed page never unmounts the editor, so the
// session outlives the shot that opened it and badges the document in every
// later scene until the lease expires. Both tools release it explicitly and
// check that scenes which should show no lock show none.
import type { APIRequestContext, Page } from "@playwright/test";

// The negotiated Supplier Agreement in the "Meridian supply agreement"
// matter (seed-dev.ts: `ws-akvizice-energo-doc-7` /
// `ws-akvizice-energo-field-file-6`), and the matter's file property
// (`ws-akvizice-energo-prop-file`), which keys its edit lock with the entity.
const MERIDIAN_WORKSPACE_ID = "6cbf3f81-bcc9-55da-8a4e-840221d4cabe";
export const SUPPLIER_AGREEMENT_ENTITY_ID =
  "84824638-eb81-58c5-8a81-5d7e961fb7d5";
export const SUPPLIER_AGREEMENT_FIELD_ID =
  "3f985a8b-26be-5a07-89d3-2a05acb94354";
const SUPPLIER_AGREEMENT_PROPERTY_ID = "fa85736e-0b89-5386-8332-c2bb53f18c46";

/** The editor route that opens the Supplier Agreement and takes its lock. */
export const SUPPLIER_AGREEMENT_EDITOR_PATH =
  `/workspaces/${MERIDIAN_WORKSPACE_ID}/all/document` +
  "?editing=true" +
  `&entity=${SUPPLIER_AGREEMENT_ENTITY_ID}` +
  `&field=${SUPPLIER_AGREEMENT_FIELD_ID}`;

/**
 * Cancel the signed-in user's live edit session on the Supplier Agreement,
 * if any (apps/api/src/handlers/entities/release-desktop-edit-lock.ts); a
 * no-op when none is open. `request` must carry the session cookies.
 */
export const releaseSupplierAgreementEditLock = async (
  request: APIRequestContext,
  { apiUrl, webUrl }: { apiUrl: string; webUrl: string },
) => {
  const response = await request.post(
    `${apiUrl}/v1/entities/${MERIDIAN_WORKSPACE_ID}/desktop-edit-sessions/release`,
    {
      data: {
        entityId: SUPPLIER_AGREEMENT_ENTITY_ID,
        propertyId: SUPPLIER_AGREEMENT_PROPERTY_ID,
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
