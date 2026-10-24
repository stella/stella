import { panic, Result } from "better-result";
import { eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { softLawSources } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { SoftLawIngestionError } from "@/api/lib/legal-search/soft-law-types";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

import {
  type RegisteredSoftLawAuthority,
  SOFT_LAW_ADMISSIONS,
} from "./adapters/registry";
import { runSoftLawIngestion } from "./ingestion";

type SyncSoftLawOptions = {
  authority: RegisteredSoftLawAuthority;
  scopedDb: ScopedDb;
  signal: AbortSignal;
};

/** Registration and retries share the existing source identity and ingestion lease. */
export const syncEuSoftLaw = async ({
  authority,
  scopedDb,
  signal,
}: SyncSoftLawOptions) => {
  const { adapter, descriptor } = SOFT_LAW_ADMISSIONS[authority];
  const auditSubject = createSafeId<"systemScriptRun">();
  const registration = await Result.tryPromise(
    async () =>
      await scopedDb(async (tx) => {
        const inserted = await tx
          .insert(softLawSources)
          .values({
            id: createSafeId<"softLawSource">(),
            adapterKey: adapter.key,
            descriptor,
          })
          .onConflictDoNothing({ target: softLawSources.adapterKey })
          .returning({ id: softLawSources.id });
        if (inserted.length > 0) {
          await recordSystemAudit(tx, "system:eu-soft-law-ingestion", {
            subject: auditSubject,
            counts: { sourcesRegistered: inserted.length },
          });
        }
        const row =
          (
            await tx
              .select({
                id: softLawSources.id,
                descriptor: softLawSources.descriptor,
              })
              .from(softLawSources)
              .where(eq(softLawSources.adapterKey, adapter.key))
              .limit(1)
          ).at(0) ?? panic("Registered soft-law source is missing");
        return row;
      }),
  );
  if (registration.status === "error") {
    return {
      status: "failed" as const,
      error: new SoftLawIngestionError({
        message: "Could not register soft-law source",
        cause: registration.error,
      }),
    };
  }
  if (
    registration.value.descriptor.allowsRedistribution ||
    registration.value.descriptor.allowsDerivedAi
  ) {
    return {
      status: "failed" as const,
      error: new SoftLawIngestionError({
        message:
          "EU soft-law acquisition requires an ingestion-only source descriptor",
      }),
    };
  }
  return await runSoftLawIngestion({
    sourceId: registration.value.id,
    adapter,
    scopedDb,
    signal,
  });
};
