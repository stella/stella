import { Result } from "better-result";
import { t } from "elysia";

import { validateContactImportCandidate } from "@/api/handlers/contacts/contact-import-file";
import {
  contactImportCandidateSchema,
  taxIdSchemeSchema,
} from "@/api/handlers/contacts/contact-import-schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { LIMITS } from "@/api/lib/limits";

const importValidateBodySchema = t.Object({
  taxIdScheme: taxIdSchemeSchema,
  rows: t.Array(contactImportCandidateSchema, {
    maxItems: LIMITS.contactsImportRowsMax,
  }),
});

const config = {
  description:
    "Check a reviewed batch of contacts against the import rules without " +
    "persisting anything: the same per-row issues a file preview reports, " +
    "over rows that may have been extracted, edited, or assembled by hand. " +
    "Under taxIdScheme br_cpf_cnpj a passing row comes back with its tax id " +
    "normalized to bare digits.",
  permissions: { contact: ["create"] },
  mcp: { type: "internal", reason: "upload_mechanics" },
  body: importValidateBodySchema,
} satisfies HandlerConfig;

const validateContactImport = createSafeRootHandler(
  config,
  async function* ({ body: { rows, taxIdScheme } }) {
    const validated = rows.map((candidate, index) => {
      const { contact, issues } = validateContactImportCandidate({
        candidate,
        taxIdScheme,
        rowNumber: index + 1,
      });
      return { contact, issues, rowNumber: index + 1 };
    });

    return Result.ok({
      errorCount: validated.reduce(
        (total, { issues }) => total + issues.length,
        0,
      ),
      rows: validated,
      validCount: validated.filter(({ issues }) => issues.length === 0).length,
    });
  },
);

export default validateContactImport;
