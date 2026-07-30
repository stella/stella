import { Result } from "better-result";

import type {
  DocumentProcessingMode,
  PracticeJurisdiction,
} from "@/api/db/schema";
import { DEFAULT_DOCUMENT_PROCESSING_MODE } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { arrayOrEmpty } from "@/api/lib/array";
import { isDocumentOcrWorkerAvailable } from "@/api/lib/document-processing-readiness";
import {
  DEFAULT_MATTER_NUMBER_PADDING,
  DEFAULT_MATTER_NUMBER_PATTERN,
} from "@/api/lib/matter-reference";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "anonymization_admin" },
  access: "read",
} satisfies HandlerConfig;

type OrganizationSettingsRow = {
  documentProcessingMode: DocumentProcessingMode;
  matterNumberPadding: number;
  matterNumberPattern: string;
  practiceJurisdictions: PracticeJurisdiction[];
  promptCachingEnabled: boolean;
};

export const projectOrganizationSettingsRow = (
  row: OrganizationSettingsRow | null | undefined,
  documentOcrAvailable: boolean,
) => ({
  documentOcrAvailable,
  documentProcessingMode:
    row?.documentProcessingMode ?? DEFAULT_DOCUMENT_PROCESSING_MODE,
  matterNumberPattern:
    row?.matterNumberPattern ?? DEFAULT_MATTER_NUMBER_PATTERN,
  matterNumberPadding:
    row?.matterNumberPadding ?? DEFAULT_MATTER_NUMBER_PADDING,
  practiceJurisdictions: arrayOrEmpty(row?.practiceJurisdictions),
  promptCachingEnabled: row?.promptCachingEnabled ?? true,
});

const readOrganizationSettings = createSafeRootHandler(
  config,
  async function* ({ safeDb, session }) {
    const row = yield* Result.await(
      safeDb((tx) =>
        tx.query.organizationSettings.findFirst({
          where: { organizationId: { eq: session.activeOrganizationId } },
          columns: {
            documentProcessingMode: true,
            matterNumberPattern: true,
            matterNumberPadding: true,
            practiceJurisdictions: true,
            promptCachingEnabled: true,
          },
        }),
      ),
    );

    return Result.ok(
      projectOrganizationSettingsRow(row, await isDocumentOcrWorkerAvailable()),
    );
  },
);

export default readOrganizationSettings;
