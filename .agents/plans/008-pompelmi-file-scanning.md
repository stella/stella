# Plan: Pompelmi File Scanning

Date: 2026-02-26

## Goal

Implement file security scanning using pompelmi and YARA rules.
Pompelmi provides ZIP bomb protection, polyglot detection (30+
signatures), obfuscated script detection, OOXML macro detection,
OLE2 container detection, and SVG active content scanning. YARA
rules give us fine-grained severity control (reject vs. warn) in
an industry-standard format.

## Design Decisions

- **Use pompelmi for heuristic scanning.** Pompelmi's
  `CommonHeuristicsScanner` covers OOXML macros, OLE
  containers, PDF risky actions, and PE executables. Its
  polyglot detector handles magic byte analysis with 30+
  signatures. `createZipBombGuard` adds ZIP bomb protection.

- **YARA rules for custom severity mapping.** Pompelmi's
  `CommonHeuristicsScanner` returns `suspicious` for all
  detections. We need `reject` for PDF JavaScript/Launch and
  `warn` for embedded files/macros. YARA rules carry `verdict`
  metadata that we map to our severity system, giving us
  precise control without maintaining TypeScript heuristics.

- **ZIP bomb protection.** `createZipBombGuard` with limits on
  entry count, total uncompressed size, and compression ratio.

- **SVG active content detection via YARA.** Detects
  `<script>`, `on*` event handlers, `foreignObject`,
  `javascript:` URIs, and external `xlink:href` references.

- **OOXML threat detection via YARA.** Detects XXE entity
  declarations, external relationships, ActiveX controls, and
  remote template references in Office documents.

- **PDF polyglot resilience.** PDF YARA rules do not anchor
  `%PDF-` to offset 0, so polyglot files (e.g., JPEG-PDF) are
  still caught.

- **Map verdicts at the boundary.** Pompelmi: `suspicious` →
  `warn`, `malicious` → `reject`. YARA: read `verdict` from
  rule meta (`malicious` → `reject`, `suspicious` → `warn`).

- **Reject corrupt ZIP-based formats.** Files declared as
  ZIP-based MIME types (OOXML, etc.) without valid `PK\x03\x04`
  magic bytes are rejected immediately.

## Scope

**In scope:**

- `scan.ts` calling pompelmi `CommonHeuristicsScanner` +
  `createZipBombGuard` + compiled YARA rules
- YARA rule files for: PDF threats, embedded executables, SVG
  active content, office macros, OOXML threats
- ZIP magic validation for ZIP-based MIME types
- Tests covering all detection categories, MIME spoofing,
  polyglot bypass, and OOXML threat vectors
- `@litko/yara-x` dependency

**Out of scope:**

- Frontend changes (scan warnings surface the same way)
- Threat intelligence aggregation (future)
- Batch scanning (single-file upload flow)
- Streaming (buffer-based fine for 50 MB limit)
- Template endpoint scanning (under development)

## Implementation

### Files

- `apps/api/src/lib/file-scan/scan.ts` — core scanner. Calls
  pompelmi heuristics + ZIP bomb guard, then YARA rules.
  Maps results to `ScanFinding[]` with severity. Returns
  `Result<ScanResult, FileScanError>`.

- `apps/api/src/lib/file-scan/scan.test.ts` — 32 tests across
  8 describe blocks

- `apps/api/src/lib/file-scan/yara/pdf-threats.yar` — rules
  for `/JS`, `/JavaScript`, `/Launch` (verdict: malicious);
  `/EmbeddedFile`, `/OpenAction` + `/URI` (verdict: suspicious)

- `apps/api/src/lib/file-scan/yara/executables.yar` — rules
  for PE (MZ + PE\0\0 validation), ELF, Mach-O at offset > 64
  (verdict: suspicious)

- `apps/api/src/lib/file-scan/yara/svg-content.yar` — rules
  for `<script>`, `on*=` events, `foreignObject`,
  `javascript:` URIs, external `xlink:href`/`data:` refs
  (verdict: suspicious)

- `apps/api/src/lib/file-scan/yara/office-macros.yar` — rule
  for suspicious VBA keywords (AutoOpen + CreateObject/Shell)
  (verdict: malicious)

- `apps/api/src/lib/file-scan/yara/ooxml-threats.yar` — rules
  for XXE entity declarations (malicious), external
  relationships (suspicious), ActiveX controls (malicious),
  remote template references (malicious)

### Unchanged

- `apps/api/src/handlers/entities/upload.ts` — consumes
  `scanFile` with the same contract (`verdict`, `findings`)

## Test Cases

- PDF with `/JavaScript` → reject (YARA)
- PDF with `/Launch` → reject (YARA)
- PDF with `/EmbeddedFile` → warn (YARA)
- PDF with `/OpenAction` + `/URI` → warn (YARA)
- PE executable embedded at offset > 64 → warn (YARA)
- ELF signature embedded → warn (YARA)
- Bare MZ without PE header → no false positive (YARA)
- DOCX with vbaProject.bin → warn (pompelmi heuristics)
- OLE2 container → warn (pompelmi heuristics)
- DOCX with suspicious macro keywords → reject (YARA)
- DOCX with XXE entity declaration → reject (YARA)
- DOCX with external relationship → warn (YARA)
- DOCX with ActiveX control → reject (YARA)
- DOCX with remote template reference → reject (YARA)
- SVG with `<script>` → warn (YARA)
- SVG with `onload=` → warn (YARA)
- SVG with `foreignObject` → warn (YARA)
- SVG with `javascript:` URI → warn (YARA)
- SVG with external `xlink:href` → warn (YARA)
- SVG with `data:` href → warn (YARA)
- PDF polyglot (JPEG header + PDF body) → reject (YARA)
- MIME spoofing: PDF-as-PNG, SVG-as-text, ELF-as-JPEG,
  OLE2-as-CSV → all still caught
- Corrupt ZIP declared as DOCX → reject
- Clean PDF → pass
- Clean DOCX → pass
- Clean SVG → pass
- Performance: 1 MB buffer < 500 ms
