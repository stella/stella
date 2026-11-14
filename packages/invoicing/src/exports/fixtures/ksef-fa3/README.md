# KSeF FA(3) schema

The official FA(3) structured-invoice schema of the Polish Ministry of
Finance and the shared type schemas it imports, unmodified, retrieved
2026-10-20. `ksef-fa3.test.ts` validates every generated invoice against
them in-process with libxml2 compiled to WebAssembly. The test removes the
shared crd.gov.pl URL prefix from import locations in memory so the vendored
copies resolve offline.

- `schemat.xsd` — https://crd.gov.pl/wzor/2025/06/25/13775/schemat.xsd
- `StrukturyDanych_v10-0E.xsd`, `ElementarneTypyDanych_v10-0E.xsd`,
  `KodyKrajow_v10-0E.xsd` — http://crd.gov.pl/xml/schematy/dziedzinowe/mf/2022/01/05/eD/DefinicjeTypy/

Field meanings: the Ministry's information sheet on the FA(3) logical
structure,
https://ksef.podatki.gov.pl/media/4u1bmhx4/information-sheet-on-the-fa-3-logical-structure.pdf.
