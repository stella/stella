import type { ScopedDb } from "@/api/db/safe-db-types";
import type { Transaction } from "@/api/db/types";
import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";
import {
  type ZipNameCodePage,
  zipNameCodePageFor,
} from "@/api/lib/files/zip-name-code-page";

/**
 * The code page an organization's ZIP archives settle a tie in, from its
 * practice jurisdictions: one read of its settings row by its unique
 * organization key. An organization that never saved settings practises
 * nowhere yet and keeps the specification's.
 */
export const readZipNameCodePage = async (
  tx: { query: Pick<Transaction["query"], "organizationSettings"> },
  organizationId: SafeId<"organization">,
): Promise<ZipNameCodePage> => {
  const row = await tx.query.organizationSettings.findFirst({
    where: { organizationId: { eq: organizationId } },
    columns: { practiceJurisdictions: true },
  });
  return zipNameCodePageFor(
    arrayOrEmpty(row?.practiceJurisdictions).map(
      (jurisdiction) => jurisdiction.countryCode,
    ),
  );
};

/** An organization's code page, read when a file first reaches the worker. */
export type ZipNameCodePageSource = () => Promise<ZipNameCodePage>;

/**
 * `readZipNameCodePage` on first use and remembered after: a request reads
 * the settings row once however many archives it opens, and not at all when
 * it opens none.
 */
export const zipNameCodePageSource = (
  scopedDb: ScopedDb,
  organizationId: SafeId<"organization">,
): ZipNameCodePageSource => {
  let read: Promise<ZipNameCodePage> | undefined;
  return async () => {
    read ??= scopedDb(
      async (tx) => await readZipNameCodePage(tx, organizationId),
    );
    return await read;
  };
};
