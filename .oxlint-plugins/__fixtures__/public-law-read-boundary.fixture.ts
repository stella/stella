// Passive regression fixture for public-law-read-boundary.

declare const readPublicDecisionLanguageAlternatesByGroup: () => Promise<void>;
declare const configureExternalReadTransaction: (
  tx: unknown,
  isolation: string,
) => Promise<void>;
declare const configureReadTransaction: (
  tx: unknown,
  isolation: string,
) => Promise<void>;
declare const envBase: { PUBLIC_LAW_DATABASE_URL?: string };
declare const shouldConfigureExternalReadTransaction: () => boolean;
declare const database: {
  transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
};

export const searchPostgresDecisions = async () => {
  await readPublicDecisionLanguageAlternatesByGroup();
};

// oxlint-disable-next-line public-law-read-boundary/require-language-alternate-counts -- fixture: a nested callback does not prove this search path invokes the shared reader
export const searchCorpusIndexDecisions = () => {
  const deferredRead = async () =>
    await readPublicDecisionLanguageAlternatesByGroup();
  return deferredRead;
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
