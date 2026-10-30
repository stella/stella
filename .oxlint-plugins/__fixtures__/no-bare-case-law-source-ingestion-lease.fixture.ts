declare const options: unknown;
declare const work: () => Promise<unknown>;
declare const acquireCaseLawSourceIngestionLease: (
  value: unknown,
) => Promise<unknown>;
declare const withCaseLawSourceIngestionLease: (
  value: unknown,
  callback: () => Promise<unknown>,
) => Promise<unknown>;

// oxlint-disable-next-line no-bare-case-law-source-ingestion-lease/no-bare-case-law-source-ingestion-lease -- fixture: direct acquisition must be rejected
await acquireCaseLawSourceIngestionLease(options);

await withCaseLawSourceIngestionLease(options, work);

// expect-clean: no-bare-case-law-source-ingestion-lease/no-bare-case-law-source-ingestion-lease
