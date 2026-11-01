import type { APIRequestContext } from "@playwright/test";
import { expect } from "@playwright/test";

import { apiGet, E2E_API_ORIGIN } from "./api";

const AUDIT_EXPORT_PATH = "/organizations/audit-export";
const AUDIT_EXPORT_READY_TIMEOUT_MS = 120_000;

type AuditExportLatest = {
  latest: { status: string; coversCurrentTrail?: boolean } | null;
};

/**
 * Delete the request context's active organization the way an owner does:
 * export its audit log, wait for the archive, then delete.
 */
export const deleteTestOrganization = async (
  request: APIRequestContext,
  organizationId: string,
): Promise<void> => {
  const requested = await request.post(
    `${E2E_API_ORIGIN}/v1${AUDIT_EXPORT_PATH}`,
  );
  expect(requested.ok(), await requested.text()).toBe(true);
  await expect
    .poll(
      async () =>
        (await apiGet<AuditExportLatest>(request, AUDIT_EXPORT_PATH)).latest,
      { timeout: AUDIT_EXPORT_READY_TIMEOUT_MS },
    )
    .toMatchObject({ status: "ready", coversCurrentTrail: true });
  const deleted = await request.post(
    `${E2E_API_ORIGIN}/api/auth/organization/delete`,
    { data: { organizationId } },
  );
  expect(deleted.ok(), await deleted.text()).toBe(true);
};
