import { panic, Result } from "better-result";
import { t } from "elysia";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  dataBoxIdSchema,
  saveOrganizationDataBoxes,
} from "@/api/lib/data-box/organization-boxes";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const concurrentChange = () =>
  new HandlerError({
    status: 409,
    message:
      "The organization's data boxes changed concurrently; read them again and retry",
  });

const config = {
  contract: "patch",
  description:
    "Remove one of the organization's own data-box IDs and re-derive the direction of the data-box messages filed in the matters the caller can reach. Removing an ID not listed changes nothing but re-derives; recomputed counts the records whose direction changed.",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  mcp: {
    type: "capability",
    reason: "correspondence",
    consumesServices: false,
  },
  params: t.Object({ boxId: dataBoxIdSchema }),
} satisfies HandlerConfig;

const removeOrganizationDataBox = createSafeRootHandler(
  config,
  async function* ({ params, safeDb, session, recordAuditEvent }) {
    const boxId = params.boxId.toLowerCase();
    const saved = yield* Result.await(
      safeDb(
        async (tx) =>
          await saveOrganizationDataBoxes({
            tx,
            organizationId: session.activeOrganizationId,
            recordAuditEvent,
            change: (current) => current.filter((id) => id !== boxId),
          }),
      ),
    );
    switch (saved.type) {
      case "saved":
        return Result.ok(saved.value);
      case "conflict":
        return Result.err(concurrentChange());
      case "limit_reached":
        return panic("Removing a data box cannot exceed the limit");
      default:
        saved satisfies never;
        return panic("Unhandled data box change");
    }
  },
);

export default removeOrganizationDataBox;
