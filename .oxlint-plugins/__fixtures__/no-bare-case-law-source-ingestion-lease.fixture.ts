// oxlint-disable-next-line no-bare-case-law-source-ingestion-lease/no-bare-case-law-source-ingestion-lease -- fixture: importing the acquisition under any name must be rejected
import { acquireCaseLawSourceIngestionLease as claim } from "./case-law-source-ingestion-lease";
import * as leases from "./case-law-source-ingestion-lease";

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

// oxlint-disable-next-line no-bare-case-law-source-ingestion-lease/no-bare-case-law-source-ingestion-lease -- fixture: imported aliases must be rejected
await claim(options);

const localClaim = claim;
// oxlint-disable-next-line no-bare-case-law-source-ingestion-lease/no-bare-case-law-source-ingestion-lease -- fixture: local aliases must be rejected
await localClaim(options);

// oxlint-disable-next-line no-bare-case-law-source-ingestion-lease/no-bare-case-law-source-ingestion-lease -- fixture: namespace members must be rejected
await leases.acquireCaseLawSourceIngestionLease(options);

const runtime = await import("./case-law-source-ingestion-lease");
// oxlint-disable-next-line no-bare-case-law-source-ingestion-lease/no-bare-case-law-source-ingestion-lease -- fixture: members of a module loaded on demand must be rejected
await runtime.acquireCaseLawSourceIngestionLease(options);

// expect-clean: no-bare-case-law-source-ingestion-lease/no-bare-case-law-source-ingestion-lease
await withCaseLawSourceIngestionLease(options, work);
