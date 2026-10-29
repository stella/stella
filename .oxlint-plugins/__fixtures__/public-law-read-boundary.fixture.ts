// Passive regression fixture for public-law-read-boundary.

import { withPublicReadIo } from "@/api/lib/legal-search/public-read-timeout-context";
import { readPublicDecisionLanguageAlternatesByGroup } from "@/api/lib/case-law/language-alternates";

declare const configureExternalReadTransaction: (
  tx: unknown,
  isolation: string,
) => Promise<void>;
// expect-clean: public-law-read-boundary/require-configured-read-transaction
declare const configureReadTransaction: (
  tx: unknown,
  isolation: string,
) => Promise<void>;
declare const envBase: { PUBLIC_LAW_DATABASE_URL?: string };
declare const shouldConfigureExternalReadTransaction: () => boolean;
declare const database: {
  transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
};

// expect-clean: public-law-read-boundary/require-language-alternate-counts
export const searchPostgresDecisions = async () => {
  await readPublicDecisionLanguageAlternatesByGroup();
};

// oxlint-disable-next-line public-law-read-boundary/require-language-alternate-counts -- fixture: a nested callback does not prove this search path invokes the shared reader
export const searchCorpusIndexDecisions = () => {
  const deferredRead = async () =>
    await readPublicDecisionLanguageAlternatesByGroup();
  return deferredRead;
};

// expect-clean: public-law-read-boundary/require-language-alternate-counts
export const listCaseLawProvisionDecisions = async () => {
  await readPublicDecisionLanguageAlternatesByGroup();
};

// oxlint-disable-next-line public-law-read-boundary/require-configured-read-transaction -- fixture: the primary database branch reaches fn without read-only configuration
export const publicLawReadDb = async <T>(
  fn: (tx: unknown) => Promise<T>,
): Promise<T> =>
  await database.transaction(async (tx) => {
    const isolation = "read-committed";
    if (envBase.PUBLIC_LAW_DATABASE_URL !== undefined) {
      if (shouldConfigureExternalReadTransaction()) {
        await configureExternalReadTransaction(tx, isolation);
      }
    } else {
      await configureReadTransaction(tx, isolation);
    }
    return await fn(tx);
  });

// oxlint-disable-next-line public-law-read-boundary/require-owned-public-read-transport -- fixture: a raw request cannot own public-read settlement
await fetch("https://example.test/document");

// expect-clean: public-law-read-boundary/require-owned-public-read-transport
await withPublicReadIo("corpus-index", async (io) =>
  await io.fetch("https://example.test/document", { timeoutMs: 1000 }, async (response) => await response.text()),
);
