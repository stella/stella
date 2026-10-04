// Passive regression fixture for
// `raw-hash-from-source-fingerprint/raw-hash-from-source-fingerprint`.

declare const hashContent: (input: string) => string;
declare const sourceFingerprint: (stored: { sourceRaw: string }) => string;
declare const decision: { rawHash: string; caseNumber: string };

const docket = decision.caseNumber;
const sourceRaw = `{"parts":{"document":"${docket}"}}`;

export const identityHashed = {
  // oxlint-disable-next-line raw-hash-from-source-fingerprint/raw-hash-from-source-fingerprint -- a hash over the docket and date must use the owner
  rawHash: hashContent(`${docket}|2026-05-28`),
};

// oxlint-disable-next-line raw-hash-from-source-fingerprint/raw-hash-from-source-fingerprint -- an assigned hand-written hash must use the owner
decision.rawHash = hashContent(sourceRaw);

// expect-clean: raw-hash-from-source-fingerprint/raw-hash-from-source-fingerprint
export const fingerprinted = { rawHash: sourceFingerprint({ sourceRaw }) };
export const passedThrough = { ...decision, rawHash: decision.rawHash };
