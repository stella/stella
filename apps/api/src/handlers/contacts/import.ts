import { Result } from "better-result";

import {
  importContactRows,
  importContactsBodySchema,
} from "@/api/handlers/contacts/import-contacts";
import { captureError } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { flushContactSearchRepairs } from "@/api/lib/search/projection-repair-flush";

const config = {
  contract: "patch",
  description:
    "Import a reviewed batch of up to 500 contacts into the organization " +
    "address book. Supply a caller-generated importRequestId: replaying it " +
    "with the same rows returns the original result, while changing the rows " +
    "is rejected. taxIdScheme selects tax-id validation (none, or " +
    "br_cpf_cnpj checksums with duplicate detection). A row may carry " +
    "external (source and id in the system it came from): a later import " +
    "of the same ref updates that contact instead of creating another, so " +
    "re-running an import converges. Rows failing the import rules, " +
    "duplicates, and over-limit rows are skipped; all accepted rows commit " +
    "atomically.",
  // A row whose external ref matches a stored contact updates it.
  permissions: { contact: ["create", "update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    consumesServices: false,
    reason: "contact_directory",
  },
  body: importContactsBodySchema,
} satisfies HandlerConfig;

const importContacts = createSafeRootHandler(
  config,
  async function* ({ body, safeDb, session, user, recordAuditEvent }) {
    const outcome = yield* Result.await(
      importContactRows({
        safeDb,
        organizationId: session.activeOrganizationId,
        userId: user.id,
        recordAuditEvent,
        body,
      }),
    );

    if (outcome.status === "conflict") {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Import request was already used for different contacts",
        }),
      );
    }

    const writtenContactIds = outcome.result.results.flatMap((result) =>
      result.status === "skipped" ? [] : [result.contactId],
    );
    if (writtenContactIds.length > 0) {
      flushContactSearchRepairs(writtenContactIds).catch(captureError);
    }

    return Result.ok({
      ...outcome.result,
      replayed: outcome.status === "replayed",
    });
  },
);

export default importContacts;
