import { panic, Result } from "better-result";
import * as v from "valibot";

import { searchHistoryPathJurisdiction } from "@stll/api-contract/search-history-identity";
import { runBackfillPass } from "@stll/db-load-gate/backfill-pass";
import { defaultConfig } from "@stll/db-load-gate/health";
import type { Verdict } from "@stll/db-load-gate/health";

import { createSafeId } from "@/api/lib/branded-types";
import { decryptContent } from "@/api/lib/content-encryption";
import {
  querySearchHistoryJurisdictionRepairBatch,
  SEARCH_HISTORY_LEGACY_DOCUMENT_SQL,
  SEARCH_HISTORY_PENDING_DOCUMENT_SQL,
} from "@/api/lib/db/aggregate-lock";
import { brandPersistedOrganizationId } from "@/api/lib/safe-id-boundaries";
import { systemAuditRow } from "@/api/lib/system-audit/record";
import { isRecord } from "@/api/lib/type-guards";

import { createBackfillRuntime } from "./backfill-runtime";
import type {
  OnlineMigrationConnection,
  OnlineMigrationParam,
  OnlineRepair,
  OnlineRepairCompletion,
} from "./online-migration-connection";

const REPAIR_NAME = "search-history-jurisdiction";
const AUDIT_ACTOR = "system:search-history-jurisdiction-repair";
const BATCH = 50;
// The kind CHECK leaves decision and statute as the only non-search rows.
const openedPath = v.object({ path: v.string() });

type LegacyRow = {
  id: string;
  organizationId: string;
  ciphertext: Buffer;
  iv: Buffer;
};

const decodeLegacyRow = (value: unknown): LegacyRow => {
  if (
    !isRecord(value) ||
    typeof value["id"] !== "string" ||
    typeof value["organization_id"] !== "string" ||
    !(value["ciphertext"] instanceof Uint8Array) ||
    !(value["iv"] instanceof Uint8Array)
  ) {
    return panic("Invalid legacy search history document row");
  }
  return {
    id: value["id"],
    organizationId: value["organization_id"],
    ciphertext: Buffer.from(value["ciphertext"]),
    iv: Buffer.from(value["iv"]),
  };
};

const countryOfLegacyDocument = (plaintext: string): string | null => {
  const json = Result.try((): unknown => JSON.parse(plaintext));
  if (Result.isError(json)) {
    return null;
  }
  const parsed = v.safeParse(openedPath, json.value);
  return parsed.success
    ? searchHistoryPathJurisdiction(parsed.output.path)
    : null;
};

const hasRows = async (
  connection: Pick<OnlineMigrationConnection, "query">,
  predicate: string,
) =>
  (
    await connection.query(
      `SELECT 1 FROM public.search_history_entries WHERE ${predicate} LIMIT 1`,
    )
  ).length > 0;

const readCompletion = async (
  connection: OnlineMigrationConnection,
): Promise<OnlineRepairCompletion> => {
  const pending = await hasRows(
    connection,
    SEARCH_HISTORY_PENDING_DOCUMENT_SQL,
  );
  const failed = pending
    ? false
    : await hasRows(
        connection,
        `${SEARCH_HISTORY_LEGACY_DOCUMENT_SQL} AND jurisdiction_repair_failed_at IS NOT NULL`,
      );
  if (!pending && !failed) {
    return { type: "complete" };
  }
  const reason = failed
    ? "legacy search history documents need classification review"
    : "legacy search history documents await country classification";
  const checkpoint = await connection.query(
    "SELECT 1 FROM public.database_backfill_states WHERE name = $1",
    [REPAIR_NAME],
  );
  return checkpoint.length === 0
    ? { type: "incomplete", reason }
    : {
        type: "pending",
        reason,
        cursor: null,
        holdUntil: null,
        heldSince: null,
      };
};

type RepairRuntimeOptions = {
  readVerdict?: () => Promise<Verdict>;
  sleep?: (milliseconds: number) => Promise<void>;
  clock?: () => number;
  log?: (record: unknown) => void;
  decrypt?: typeof decryptContent;
};

export const createSearchHistoryJurisdictionRepair = ({
  readVerdict,
  sleep = Bun.sleep,
  clock,
  log,
  decrypt = decryptContent,
}: RepairRuntimeOptions = {}): OnlineRepair => ({
  name: REPAIR_NAME,
  readCompletion,
  repair: async (connection) => {
    const runtime = createBackfillRuntime({
      name: REPAIR_NAME,
      tableName: "search_history_entries",
      initialSize: BATCH,
      config: defaultConfig,
      connection,
      readVerdict,
      clock,
      log,
    });
    const subject = createSafeId<"systemScriptRun">();
    try {
      const pass = await runBackfillPass({
        holdPolicy: "propagate",
        sleep,
        step: async () =>
          await runtime.step(async ({ tx, size, cursor }) => {
            const rows = (
              await querySearchHistoryJurisdictionRepairBatch({
                connection: tx,
                cursor,
                size: Math.min(size, BATCH),
              })
            ).map(decodeLegacyRow);
            if (rows.length === 0) {
              return { cursor: null, done: true, value: 0 };
            }
            // AES/HKDF is local CPU work; no network call occurs in this bounded transaction.
            const classified = await Promise.all(
              rows.map(async ({ id, organizationId, ciphertext, iv }) => {
                const plaintext = await Result.tryPromise({
                  try: async () =>
                    await decrypt(
                      brandPersistedOrganizationId(organizationId),
                      ciphertext,
                      iv,
                    ),
                  catch: (cause: unknown) => cause,
                });
                if (
                  plaintext.isErr() &&
                  (!(plaintext.error instanceof DOMException) ||
                    plaintext.error.name !== "OperationError")
                ) {
                  // AES-GCM authentication failures need row review. A wrong
                  // configured key looks identical, so retain the encrypted
                  // row; missing key, HKDF and runtime failures still retry.
                  throw plaintext.error;
                }
                return {
                  id,
                  organizationId,
                  jurisdiction: plaintext.isOk()
                    ? countryOfLegacyDocument(plaintext.value)
                    : null,
                };
              }),
            );
            const parameters: OnlineMigrationParam[] = classified.flatMap(
              ({ id, organizationId, jurisdiction }) => [
                id,
                organizationId,
                jurisdiction,
              ],
            );
            const values = classified
              .map(
                (_, index) =>
                  `($${index * 3 + 1}::uuid, $${index * 3 + 2}::varchar, $${index * 3 + 3}::varchar)`,
              )
              .join(", ");
            await tx.query(
              `UPDATE public.search_history_entries AS entry
                  SET jurisdiction = classified.jurisdiction,
                      jurisdiction_repair_failed_at = CASE
                        WHEN classified.jurisdiction IS NULL THEN clock_timestamp()
                        ELSE NULL
                      END
                 FROM (VALUES ${values}) AS classified(id, organization_id, jurisdiction)
                WHERE entry.id = classified.id
                  AND entry.organization_id = classified.organization_id
                  AND entry.jurisdiction IS NULL
                  AND entry.jurisdiction_repair_failed_at IS NULL`,
              parameters,
            );
            const audit = systemAuditRow(AUDIT_ACTOR, {
              subject,
              counts: {
                classified: classified.filter(
                  ({ jurisdiction }) => jurisdiction !== null,
                ).length,
                unclassifiable: classified.filter(
                  ({ jurisdiction }) => jurisdiction === null,
                ).length,
              },
            });
            if (audit === null) {
              return panic(
                "Nonempty jurisdiction repair batch has no audit row",
              );
            }
            await tx.query(
              "INSERT INTO public.system_audit_runs (id, actor, subject, counts) VALUES ($1::uuid, $2, $3, $4::text::jsonb)",
              [
                audit.id,
                audit.actor,
                audit.subject,
                JSON.stringify(audit.counts),
              ],
            );
            return {
              cursor: rows.at(-1)?.id ?? null,
              done: false,
              value: rows.length,
            };
          }),
      });
      if (pass.isErr()) {
        throw pass.error;
      }
      return { type: "complete" };
    } finally {
      await runtime.close();
    }
  },
});

export const SEARCH_HISTORY_JURISDICTION_REPAIR =
  createSearchHistoryJurisdictionRepair();
