// Passive regression fixture for
// `no-literal-document-byte-limit/no-literal-document-byte-limit`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag;
// a regression makes them unused and CI fails. `expect-clean` lines cover what
// the rule must leave alone.
declare const UPLOAD_DOCUMENT_MAX_BYTES: number;

export const documentBounds = () => [
  // oxlint-disable-next-line no-literal-document-byte-limit/no-literal-document-byte-limit -- fixture: the limit as a product
  200 * 1024 * 1024,
  // oxlint-disable-next-line no-literal-document-byte-limit/no-literal-document-byte-limit -- fixture: the limit as one literal
  209_715_200,
  // oxlint-disable-next-line no-literal-document-byte-limit/no-literal-document-byte-limit -- fixture: one byte past a copied limit
  200 * 1024 * 1024 + 1,
  // expect-clean: no-literal-document-byte-limit/no-literal-document-byte-limit
  25 * 1024 * 1024,
  // expect-clean: no-literal-document-byte-limit/no-literal-document-byte-limit
  UPLOAD_DOCUMENT_MAX_BYTES + 1,
];
