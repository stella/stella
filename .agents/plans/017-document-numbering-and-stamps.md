# Plan 017: Document Numbering & DMS Stamps

## Problem

1. **Matter numbering exists but may not work reliably** — the
   code in `matter-reference.ts` and `create.ts` looks correct
   structurally, but it's untested and the user suspects issues.
2. **No document numbering** — entities (documents, files) use
   nanoid IDs which are not human-readable. Lawyers need a
   short, citable reference like `2026/001/015.v3`.
3. **No DMS stamp in DOCX footers** — downloaded documents carry
   no provenance. If a DOCX is emailed, printed, or saved
   locally, there's no way to trace it back to Stella.
4. **No round-trip re-upload** — when a modified DOCX is uploaded
   back, there's no mechanism to recognize it belongs to an
   existing entity and should create a new version instead of
   a new entity.

## Core Design Principle: References Are Forever

A document reference, once assigned, is **immutable and
permanent**. It must resolve to the same document 10 years
from now, even if:

- The firm changes their matter numbering pattern
- The matter reference is manually edited
- Stella changes its reference format entirely
- The document moves between matters (edge case; the
  reference stays with the original location)

**This means: store the full stamp string, never recompute it.**

When a document version is created, its stamp is computed once
from the current matter reference and frozen as a string in the
DB. The lookup system searches by stored stamp, not by
recomputing from the current pattern.

If a matter reference changes from `2026/001` to `2026/001-A`,
existing document stamps keep `2026/001/015.v3`. New versions
created after the rename get `2026/001-A/015.v4`. Both resolve
correctly because the lookup searches the `stamp` column, not
the workspace `reference` column.

## What Goes in the DOCX

Two layers: **visible footer** (for humans) and **custom
property** (for machines). Both controlled by the same user
consent toggle.

### Footer (visible)

```
2026/001/015.v3  stl:kx8mq2n4p3
```

Two parts:
- **Human reference** (`2026/001/015.v3`) — for verbal
  citation, emails, briefs. Plain text.
- **Verification code** (`stl:kx8mq2n4p3`) — globally unique
  lookup key, clickable hyperlink to
  `https://stella.legal/v/kx8mq2n4p3`.

Right-aligned, gray (#999999), 7pt. ~30 characters total.
Unobtrusive on print.

### Custom properties (invisible)

```xml
<!-- docProps/custom.xml -->
<property name="stella-ref">
  <vt:lpwstr>2026/001/015.v3</vt:lpwstr>
</property>
<property name="stella-code">
  <vt:lpwstr>kx8mq2n4p3</vt:lpwstr>
</property>
```

OOXML custom properties survive most editing (Word,
LibreOffice, most tools). They're invisible to the user but
trivially parseable.

### Why both

| | Footer | Custom property |
|---|---|---|
| **For** | Humans (printed, visual) | Machines (re-upload) |
| **Survives printing** | Yes | No |
| **Survives editing** | Can be deleted | Usually preserved |
| **Parse reliability** | Fragile (complex XML) | Trivial (key-value) |
| **Visible to user** | Yes | No (File → Properties) |

Re-upload matching checks custom property first (reliable),
falls back to footer parsing only if the property is missing.

### Consent model

```
Org setting: "Include document reference"
  → Default ON (new orgs)
  → Can be turned OFF org-wide
  → Per-download override always available
```

"Include document reference" controls BOTH the footer AND the
custom properties. User opts out = neither is added. One
decision, consistent behavior, no hidden metadata.

## Verification Code Design

### Why a verification code at all

The human reference (`2026/001/015.v3`) is org-scoped — two
orgs can have the same reference. The verification code is
**globally unique** and enables:

| Use case | How the code helps |
|---|---|
| **Deep linking** | URL uses the code, not the reference. No ambiguity across orgs. |
| **Enumeration prevention** | Can't guess `001/016.v1` because you don't know its code. |
| **Public verification** | `stella.legal/verify/kx8mq2n4p3` → "Valid Stella document, issued [date]." No login required, no content revealed. |
| **Content integrity** | Upload file → compare SHA-256 against stored hash for that code → "unmodified" or "modified since [date]." |
| **Cross-org sharing** | External counsel clicks link → code resolves globally → access check happens after. |
| **Self-hosted instances** | Code is domain-independent. Change domain → old codes still work. |
| **API integration** | External systems reference docs by `stl:kx8mq2n4p3`. Stable, permanent identifier. |
| **Leak forensics** (future) | Generate unique code per download instead of per version. Same format, same footer. Trace which download leaked. |
| **Multi-org users** (future) | Code resolves globally — no need to guess which org. |

### Format

10 lowercase alphanumeric characters, no ambiguous chars
(no 0/O/1/l/I). Generated via nanoid with custom alphabet.

```
Alphabet: a-hj-km-np-z2-9 (31 chars)
Length:   10
Space:    31^10 ≈ 8.2 × 10^14 (800+ trillion)
```

Prefixed with `stl:` in the footer for:
- Greppability (`grep "stl:" *.docx`)
- Distinguishing from random text during parsing
- Format versioning (`stl2:` if ever needed)

### Why random, not HMAC

HMAC depends on a per-org secret. If rotated, lost, or
compromised, all verification breaks. Random token IS the
identity — it doesn't derive from anything that can change.
No secret management, no rotation, no crypto key escrow.
Equally unguessable at 10 chars.

### Resolution flow (deep link)

```
User clicks stella.legal/v/kx8mq2n4p3
  → Lookup entityVersions WHERE verificationCode = 'kx8mq2n4p3'
  → Join to entity → workspace → org
  → If logged in + has access → open document
  → If logged in + no access → "You don't have access"
  → If not logged in → login → resolve
```

Lookup is globally unique (no org context needed for the
query itself). Access control happens after resolution.

## Document Reference Format

```
{matterRef}/{docSeq}.v{version}
```

Examples:
- `2026/001/015.v3` — matter 2026/001, document 15, version 3
- `CORP-001/003.v1` — matter CORP-001, document 3, version 1
- `001/042.v2` — matter 001, document 42, version 2

## Security Model

**The DOCX stamp contains only:**
- Human-readable reference (sequential numbers, no org info)
- Verification code (random, globally unique, reveals nothing)
- Hyperlink to `stella.legal/v/{code}`

**The stamp must NOT contain:**
- Organization name or ID
- Internal nanoid entity IDs
- Workspace nanoid IDs
- Any information that leaks org structure

**Threat model:**
- Document emailed to opposing counsel → they see a reference
  number and a code. No org name, no internal IDs. Clicking
  the link requires authentication.
- User from Org A uploads DOCX with stamp from Org B →
  verification code lookup finds the version in Org B →
  access check fails → treated as new document. No data leak.
- Forged stamp to overwrite a document → re-upload flow
  always asks for confirmation. User must have write access.
  No privilege escalation.
- Brute-force URL enumeration → 800+ trillion possible codes.
  Rate limiting makes this infeasible.

## Phases

### Phase 1: Audit & fix matter numbering

**Goal:** Ensure existing matter numbering works correctly.

**Files:**
- `apps/api/src/lib/matter-reference.ts`
- `apps/api/src/handlers/workspaces/create.ts`
- `apps/api/src/db/schema.ts` (`matterCounters` table)

**Tasks:**
1. Write tests for `validatePattern`, `toScopeKey`,
   `toReference` covering edge cases:
   - Year rollover (scope key `2025/` → `2026/`)
   - Counter reset on scope change
   - Padding overflow (seq > 999 with padding 3)
   - Concurrent creation (race condition)
2. Integration test for `createWorkspacesHandler`: create
   multiple workspaces, verify sequential references
3. Test race condition: two concurrent creates should not
   produce duplicates (the `ON CONFLICT` upsert handles
   this, but verify)
4. Fix any issues found

**Estimated effort:** 0.5 days

---

### Phase 2: Document numbering + verification codes

**Goal:** Every document/file entity gets a human-readable,
sequential reference and a globally unique verification code.
Both are stored permanently and never recomputed.

**Schema changes (`apps/api/src/db/schema.ts`):**

```ts
// Per-workspace document counter
export const documentCounters = p.pgTable(
  "document_counters",
  {
    id: pNanoid.primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    lastValue: p.integer("last_value").notNull().default(0),
  },
  (table) => [
    p.uniqueIndex("document_counters_ws_uidx")
      .on(table.workspaceId),
  ],
);
```

Add to `entities` table:
```ts
docSequence: p.integer("doc_sequence"),
// nullable — folders/tasks don't get one
```

Partial unique index:
```sql
CREATE UNIQUE INDEX entities_ws_doc_seq_uidx
  ON entities (workspace_id, doc_sequence)
  WHERE doc_sequence IS NOT NULL;
```

Add to `entityVersions` table:
```ts
versionNumber: p.integer("version_number").notNull().default(1),
// Frozen human-readable reference:
stamp: p.varchar("stamp", { length: 128 }),
// Globally unique verification code (no stl: prefix in DB):
verificationCode: p.varchar("verification_code", { length: 16 }),
```

Indexes:
```sql
-- For stamp-based lookups (re-upload matching within org):
CREATE INDEX entity_versions_stamp_idx
  ON entity_versions (stamp)
  WHERE stamp IS NOT NULL;

-- Globally unique verification code (cross-org deep links):
CREATE UNIQUE INDEX entity_versions_vcode_uidx
  ON entity_versions (verification_code)
  WHERE verification_code IS NOT NULL;
```

**On version creation:**

```ts
import { nanoid } from "nanoid";

// Custom alphabet: no ambiguous chars (0, O, 1, l, I)
const VCODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const generateVerificationCode = () =>
  nanoid(10, VCODE_ALPHABET);

// When creating an entity version:
const stamp = toDocumentReference(
  workspace.reference,
  entity.docSequence,
  versionNumber,
);
const verificationCode = generateVerificationCode();

await db.insert(entityVersions).values({
  entityId,
  versionNumber,
  stamp,
  verificationCode,
});
```

**Display:**
- Show reference in entity detail/info panel (monospace,
  copyable)
- Show in entity list as a subtle column
- Searchable — typing a reference or verification code in
  global search resolves to the entity

**Deep link route:**

```
GET /v/:code → resolve verificationCode → redirect to
  app document view (if authenticated + authorized)
```

**Estimated effort:** 2 days

---

### Phase 3: DOCX stamp injection (footer + custom properties)

**Goal:** When a DOCX is downloaded and the user opts in,
inject the document reference as a visible footer AND as
invisible custom properties.

**Architecture: inject on download, not on upload.**

Why:
- The stamp/code on the `entityVersion` row is the source
  of truth
- On-download injection reads the stored values
- If the user opts out, the original file is served unmodified
- No permanent modification of the stored file

**Consent flow:**

```
GET /files/:wsId/url/:fieldId?purpose=download&stamp=true

stamp param:
  - absent → use org default
  - true   → force stamp
  - false  → skip stamp
```

Org-level default in `organizationSettings`:
```ts
documentStampEnabled: p.boolean("document_stamp_enabled")
  .notNull()
  .default(true),
```

**Implementation:**

New utility: `apps/api/src/lib/docx-stamp.ts`

```ts
import JSZip from "jszip";

const STAMP_BOOKMARK = "stella_dms_ref";

export const injectStamp = async (
  docxBuffer: ArrayBuffer,
  stamp: string,           // "2026/001/015.v3"
  verificationCode: string, // "kx8mq2n4p3"
  baseUrl: string,          // "https://stella.legal"
): Promise<ArrayBuffer> => {
  const zip = await JSZip.loadAsync(docxBuffer);

  // 1. Inject/update custom properties
  injectCustomProperties(zip, stamp, verificationCode);

  // 2. Inject/update visible footer
  injectFooter(zip, stamp, verificationCode, baseUrl);

  return zip.generateAsync({ type: "arraybuffer" });
};
```

**Custom properties injection:**

```ts
const injectCustomProperties = (
  zip: JSZip,
  stamp: string,
  verificationCode: string,
) => {
  // Read or create docProps/custom.xml
  // Add/update stella-ref and stella-code properties
  // Update [Content_Types].xml if custom.xml is new
};
```

Result in `docProps/custom.xml`:
```xml
<Properties xmlns="...custom-properties..."
            xmlns:vt="...vt...">
  <property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}"
            pid="2" name="stella-ref">
    <vt:lpwstr>2026/001/015.v3</vt:lpwstr>
  </property>
  <property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}"
            pid="3" name="stella-code">
    <vt:lpwstr>kx8mq2n4p3</vt:lpwstr>
  </property>
</Properties>
```

**Footer injection:**

```ts
const injectFooter = (
  zip: JSZip,
  stamp: string,
  verificationCode: string,
  baseUrl: string,
) => {
  // Find or create footer XML file
  // If existing footer: append stamp paragraph
  // If existing Stella stamp (by bookmark): replace text
  // Add relationship + hyperlink for stl: code
  // Reference footer in document.xml section properties
};
```

Footer XML:
```xml
<w:p>
  <w:pPr>
    <w:jc w:val="right"/>
  </w:pPr>
  <w:bookmarkStart w:id="0" w:name="stella_dms_ref"/>
  <w:r>
    <w:rPr>
      <w:color w:val="999999"/>
      <w:sz w:val="14"/>
    </w:rPr>
    <w:t xml:space="preserve">2026/001/015.v3  </w:t>
  </w:r>
  <w:hyperlink r:id="rId_stella_vcode">
    <w:r>
      <w:rPr>
        <w:color w:val="999999"/>
        <w:sz w:val="14"/>
      </w:rPr>
      <w:t>stl:kx8mq2n4p3</w:t>
    </w:r>
  </w:hyperlink>
  <w:bookmarkEnd w:id="0"/>
</w:p>
```

The hyperlink relationship in `word/_rels/footer1.xml.rels`:
```xml
<Relationship Id="rId_stella_vcode"
  Type="http://...hyperlink"
  Target="https://stella.legal/v/kx8mq2n4p3"
  TargetMode="External"/>
```

**Edge cases:**
- Document already has a footer → append stamp paragraph
  after existing content, never replace
- Document has an existing Stella stamp (detected by
  `stella_dms_ref` bookmark) → replace text and hyperlink
  only
- Multi-section documents → inject into the default footer
  (last section's footer reference)
- Encrypted/password-protected DOCX → skip, serve original
- Non-DOCX files → skip, presigned URL as before
- Files > 50MB → skip to avoid memory pressure
- Template-generated documents → stamp after template fill,
  before serving

**Download handler changes (`read-by-id.ts`):**

For DOCX downloads with stamp enabled:
1. Fetch file bytes from S3 (instead of presigned URL)
2. Look up the entity's current version stamp + code
3. Call `injectStamp(buffer, stamp, code, baseUrl)`
4. Return modified buffer with `Content-Disposition: attachment`

For all other cases: presigned URL redirect (no change).

**ZIP downloads (`download-zip.ts`):**
Stamp each DOCX individually before adding to ZIP.

**Performance:**
- JSZip parse + modify + serialize: ~50-200ms for typical
  legal documents (1-10MB)
- Additional S3 fetch: ~20-100ms (same region)
- Total added latency: ~100-300ms vs ~5ms presigned redirect
- Acceptable for the feature value

**Estimated effort:** 2.5 days

---

### Phase 4: Round-trip re-upload (stamp recognition)

**Goal:** When a user uploads a DOCX containing Stella
metadata, detect it and offer to create a new version.

**Extraction priority:**

```
1. Read custom property "stella-code" (trivial, reliable)
2. If missing: read custom property "stella-ref" (fallback)
3. If missing: parse footer for stl: bookmark (last resort)
```

Custom properties are the primary source. Footer parsing
is a fallback for documents edited in tools that strip
properties but preserve footers.

**Extraction:**

```ts
export const extractStamp = async (
  docxBuffer: ArrayBuffer,
): Promise<{
  verificationCode: string | null;
  stamp: string | null;
}> => {
  const zip = await JSZip.loadAsync(docxBuffer);

  // 1. Try custom properties (fast, reliable)
  const customXml = await zip
    .file("docProps/custom.xml")
    ?.async("string");
  if (customXml) {
    const code = parseProperty(customXml, "stella-code");
    const ref = parseProperty(customXml, "stella-ref");
    if (code || ref) return { verificationCode: code, stamp: ref };
  }

  // 2. Fallback: parse footer XML for bookmark
  // (slower, less reliable, but covers edge cases)
  return parseFooterStamp(zip);
};
```

**Lookup:**

```ts
// Primary: by verification code (globally unique)
if (extracted.verificationCode) {
  const match = await db
    .select(...)
    .from(entityVersions)
    .innerJoin(entities, ...)
    .innerJoin(workspaces, ...)
    .where(
      and(
        eq(workspaces.organizationId, organizationId),
        eq(entityVersions.verificationCode,
           extracted.verificationCode),
      ),
    )
    .limit(1);
}

// Fallback: by stamp string (org-scoped)
if (!match && extracted.stamp) {
  // Search by stamp within org
}
```

**Frontend flow:**

```
User uploads DOCX to a matter
  → Server extracts stamp metadata
  → Looks up match within user's org
  → If match found AND user has write access:
      → Returns: { entityId, entityName, stamp,
          workspaceId, workspaceName }
      → Frontend dialog:
        "This appears to be a new version of
         [Document Name] (2026/001/015.v3) in
         [Matter Name].
         [Update existing] [Upload as new document]"
      → "Update existing" → create new entityVersion
         (with new stamp reflecting new version number
          and new verification code)
      → "Upload as new" → normal upload flow
  → If match in different workspace:
      → Dialog clarifies which matter the doc belongs to
      → User can update in the original matter or upload
        as new in current matter
  → If no match:
      → Normal upload flow (no dialog)
```

**Security:**
- Lookup scoped by `organizationId` (even for verification
  code — add org check after global resolution)
- Write access check before offering "update existing"
- No information about other orgs' documents revealed
- Unmatched stamp → silent new document

**Estimated effort:** 2 days

---

## Total Estimated Effort

| Phase | Effort |
|---|---|
| 1. Audit & fix matter numbering | 0.5 days |
| 2. Document numbering + verification codes | 2 days |
| 3. DOCX stamp injection (footer + properties) | 2.5 days |
| 4. Round-trip re-upload | 2 days |
| **Total** | **7 days** |

## Additional Considerations

### What about PDFs?

v1 stamps DOCX only. PDF stamping requires `pdf-lib` (drawing
text on the page, not XML manipulation). Many lawyers work in
DOCX and only export to PDF for final delivery, so DOCX covers
the primary workflow. PDF can be a follow-up.

### What about template-generated documents?

Documents generated from templates (via `fill-by-id.ts`) should
also get stamps. The fill handler already proxies the file, so
injecting after template fill is straightforward. The entity and
version are created during the fill flow.

### What about batch operations?

ZIP downloads should stamp each DOCX in the archive. This
multiplies latency by the number of DOCX files. For large
folders, stamp in parallel (Promise.all on the JSZip operations).

### What about Word Online / Google Docs?

OOXML footers and custom properties are generally preserved by
Word Online and Google Docs. Needs testing with real documents.
If a specific tool strips custom properties, the footer
bookmark fallback handles re-upload matching.

### What about printing?

The footer appears on every printed page. This is intended — a
printed document carries its reference. Users can download
without the stamp for print-sensitive contexts.

### What about the reference in the filename?

Some DMS systems rename downloads to include the reference:
`2026-001-015-v3_Contract.docx`. Nice touch but changes the
expected filename. Consider as an org-level option in v2.

### What if the firm changes their numbering pattern?

Existing stamps are frozen. New versions get stamps with the
new pattern. Both old and new resolve via the stored `stamp`
column.

### What if an entity is deleted?

Stamp becomes orphan. Upload with orphaned stamp → no match →
treated as new document. No error, no confusion.

### What if an entity moves between matters?

Don't allow in v1. The version-level stamp history naturally
supports it later: old versions keep old stamps, new version
in new matter gets new stamp.

### What about the `stl:` prefix versioning?

If the verification code format ever needs to change (longer
codes, different alphabet), the `stl:` prefix allows detection
of v1 codes. A future `stl2:` prefix would signal a new format
without breaking existing documents. The parser handles both.

### Per-download leak forensics (power-up: "Document Forensics")

**Concept:** opt-in per org. Every DOCX download gets a unique `stl:` code
instead of sharing the version's code. The footer format is
identical — the user never knows the code is per-download.
If a privileged document leaks, the org admin looks up the
code from the leaked file and sees exactly who downloaded it,
when, and from which IP.

**Why it's a power-up, not core:**
- Core users don't need forensic tracing
- It creates significantly more DB rows (every download = row)
- It's a compliance/security feature that enterprises expect
  to pay for
- Nobody resents paying for leak forensics

**Schema:**

```ts
export const downloadCodes = p.pgTable(
  "download_codes",
  {
    id: pNanoid.primaryKey(),
    // Links back to the version:
    entityVersionId: p.varchar("entity_version_id", { length: 21 })
      .notNull()
      .references(() => entityVersions.id, { onDelete: "cascade" }),
    // Unique per-download code (same format as verificationCode):
    code: p.varchar("code", { length: 16 }).notNull(),
    // Who downloaded:
    userId: p.varchar("user_id", { length: 21 })
      .notNull()
      .references(() => user.id),
    // Context:
    ipAddress: p.varchar("ip_address", { length: 45 }), // IPv6
    userAgent: p.varchar("user_agent", { length: 512 }),
    downloadedAt: p.timestamp("downloaded_at").notNull().defaultNow(),
  },
  (table) => [
    p.uniqueIndex("download_codes_code_uidx").on(table.code),
    p.index("download_codes_version_idx")
      .on(table.entityVersionId),
  ],
);
```

**How it works:**

v1 (core, no forensics):
```
Download DOCX → inject version's verificationCode
  → footer: "2026/001/015.v3  stl:kx8mq2n4p3"
  → same code for every download of this version
```

With forensics power-up enabled:
```
Download DOCX → generate new downloadCode
  → insert into downloadCodes (linking to version)
  → inject the per-download code instead
  → footer: "2026/001/015.v3  stl:r7yne4h2wp"
  → unique code, traceable to this specific download
```

**Download handler change (minimal):**

```ts
const getStampCode = async (
  entityVersionId: string,
  verificationCode: string,
  orgHasForensics: boolean,
  userId: string,
  ip: string,
  userAgent: string,
): Promise<string> => {
  if (!orgHasForensics) return verificationCode;

  const code = generateVerificationCode();
  await db.insert(downloadCodes).values({
    entityVersionId,
    code,
    userId,
    ipAddress: ip,
    userAgent,
  });
  return code;
};
```

**Re-upload matching still works:** the lookup checks
`entityVersions.verificationCode` first, then falls back
to `downloadCodes.code` → join to `entityVersions`. The
re-upload flow is unaffected.

**Admin investigation UI:**

```
Admin opens document → "Download history" tab
  → Table: [User] [Date] [IP] [Download code]
  → Admin pastes code from leaked document
  → Matches to row → "Downloaded by [Name] on [Date]"
```

**Audit log entry on download (always, even without forensics):**

Even without the power-up, log every download:
```ts
// Always log (audit trail, no per-download code):
{ action: "document.downloaded", entityVersionId, userId,
  ip, timestamp }
```

The forensics power-up adds the per-download code on top
of this, enabling code-to-person tracing from the document
itself (not just from the audit log).

**What makes this a good power-up:**
- Zero friction: same footer format, invisible to users
- High value: legal privilege breaches are career-ending;
  firms will pay to have tracing
- Low implementation cost: one new table, one conditional
  branch in the download handler
- Clean upsell: "You already have document references.
  Upgrade to Document Forensics to trace every download."

## Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Footer injection breaks formatting | High | Test with 20+ real DOCX files. Append-only: never modify existing footer content. Use bookmark for idempotent updates. |
| Memory pressure from proxying DOCX | Medium | Skip for files > 50MB. Typical legal docs (1-10MB) are fine to buffer. |
| Custom properties stripped by tool | Low | Footer bookmark is the fallback. Extraction checks both. |
| Race condition on document counter | Low | Same upsert + increment as matter counters, already proven. |
| User confusion on re-upload dialog | Medium | Clear wording with document + matter names. "Upload as new" is always the safe default. |
| Old stamps reference renamed matters | None | Stamps are frozen strings. Lookup by stamp column. |

## Non-goals (v1)

- PDF stamping
- Configurable stamp format per org
- Stamp in headers (footer only)
- QR code in footer
- Reference in filename
- Cross-matter entity moves
- Per-download forensic codes (power-up; schema designed,
  implementation deferred until power-up system exists)
- Public verification page (future; the code supports it)
- Content integrity verification (future; SHA-256 is already
  stored on files)

## Dependencies

- **JSZip** — already used in `download-zip.ts`
- **nanoid** — already used throughout the codebase
- **No new runtime dependencies**
