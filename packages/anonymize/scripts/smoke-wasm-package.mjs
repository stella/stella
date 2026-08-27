/**
 * Smoke test for the @stll/anonymize-wasm PACKAGE ENTRY (not just the raw
 * binding): exercises the built `wasm/dist/wasm.mjs` under Node.
 *
 * Proves the native-SDK surface works end to end: lazy `getBinding()` initializes
 * the generated ESM module, a compressed prepared package is byte-loaded into a
 * pipeline, `redactText` round-trips offsets, and `deanonymise` restores the
 * original text from the redaction map.
 *
 * Prerequisites:
 *   - `bun run build:native-wasm`        (produces native-wasm-dist/)
 *   - `bun run build`                    (produces wasm/dist/wasm.mjs)
 *   - `bun run build:wasm-assets`        (assembles wasm/dist/native/)
 *
 * `loadDefaultPipeline()` resolves the bundled default package from a file:
 * URL (import.meta.url). Node's global fetch cannot read file: URLs, so
 * `toPackageBytes` now reads those through node:fs; this smoke exercises that
 * path here (previously it could only byte-load the default package).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { strToU8, zipSync } from "fflate";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(here);
const entryPath = join(packageRoot, "wasm", "dist", "wasm.mjs");
const nativeNodeEntryPath = join(packageRoot, "dist", "native-node.mjs");
const defaultPackagePath = join(
  packageRoot,
  "wasm",
  "dist",
  "native",
  "native-pipeline.stlanonpkg",
);
const pdfFixturePath = join(
  packageRoot,
  "..",
  "..",
  "crates",
  "anonymize-pdf-core",
  "tests",
  "fixtures",
  "minimal-text.pdf",
);
const CONTENT_TYPES_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/content-types";
const PACKAGE_RELATIONSHIPS_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_RELATIONSHIPS_NAMESPACE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const WORD_NAMESPACE =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

for (const [label, path] of [
  ["package entry", entryPath],
  ["native Node entry", nativeNodeEntryPath],
  ["default package", defaultPackagePath],
]) {
  if (!existsSync(path)) {
    throw new Error(
      `Missing ${label}: ${path}. Run "bun run build:native-wasm", "bun run build", then "bun run build:wasm-assets".`,
    );
  }
}

// eslint-disable-next-line stll/no-dynamic-import-specifier
const entry = await import(pathToFileURL(entryPath).href);
// eslint-disable-next-line stll/no-dynamic-import-specifier
const nativeNodeEntry = await import(pathToFileURL(nativeNodeEntryPath).href);

const {
  getBinding,
  native_package_version: nativePackageVersion,
  createPipeline,
  loadPipeline,
  loadDefaultPipeline,
  deanonymise,
  defaultPackageUrl,
  CAPABILITY_MANIFEST,
  inspect_pdf_json: inspectPdfJson,
  NATIVE_BINDING_PARITY_MEMBERS,
} = entry;

if (
  CAPABILITY_MANIFEST.schemaVersion !== 2 ||
  CAPABILITY_MANIFEST.entities.length === 0
) {
  throw new TypeError("wasm capability manifest is missing or invalid");
}

const binding = await getBinding();
if (typeof binding.nativePackageVersion !== "function") {
  throw new TypeError("getBinding() did not return a native binding");
}
if (typeof binding.inspectPdfJson !== "function") {
  throw new TypeError("getBinding() did not expose PDF inspection");
}
assertFunctionMembers(
  "wasm binding",
  binding,
  NATIVE_BINDING_PARITY_MEMBERS.root,
);
assertFunctionMembers(
  "wasm prepared factories",
  binding.NativePreparedSearch,
  NATIVE_BINDING_PARITY_MEMBERS.factories,
);

const packageOnlyBinding = {
  ...binding,
  assembleStaticSearchConfigJson: () => {
    throw new Error("bundled language package was assembled at runtime");
  },
};
for (const language of ["cs", "de", "en"]) {
  await createPipeline({ binding: packageOnlyBinding, language });
}

const docxBytes = minimalDocx("Contact 😀 Alice Smith");
const nodeBinding = nativeNodeEntry.loadNativeAnonymizeBinding();
const nodeExtractionJson = nodeBinding.extractDocxTextJson(docxBytes);
const wasmExtractionJson = binding.extractDocxTextJson(docxBytes);
if (wasmExtractionJson !== nodeExtractionJson) {
  throw new Error("Node and wasm DOCX extraction results are not exact");
}
const extraction = JSON.parse(nodeExtractionJson);
const block = extraction.blocks?.at(0);
if (block?.text !== "Contact 😀 Alice Smith") {
  throw new Error("DOCX parity fixture did not expose its expected block");
}
const rewritesJson = JSON.stringify([
  {
    location: block.location,
    expectedText: block.text,
    replacements: [{ start: 11, end: 22, replacement: "[PERSON_1]" }],
  },
]);
const nodeRewrite = nodeBinding.rewriteDocxTextNative(docxBytes, rewritesJson);
const wasmRewrite = binding.rewriteDocxTextNative(docxBytes, rewritesJson);
if (
  nodeRewrite.rewrittenBlockCount !== wasmRewrite.rewrittenBlockCount ||
  nodeRewrite.appliedReplacementCount !== wasmRewrite.appliedReplacementCount ||
  !Buffer.from(nodeRewrite.document).equals(Buffer.from(wasmRewrite.document))
) {
  throw new Error("Node and wasm DOCX rewrite results are not exact");
}
const rewrittenExtraction = JSON.parse(
  binding.extractDocxTextJson(wasmRewrite.document),
);
if (rewrittenExtraction.blocks?.at(0)?.text !== "Contact 😀 [PERSON_1]") {
  throw new Error("wasm DOCX rewrite did not preserve UTF-16 span behavior");
}

const pdfBytes = new Uint8Array(readFileSync(pdfFixturePath));
const nodePdfJson = nodeBinding.inspectPdfJson(pdfBytes);
const directPdfJson = binding.inspectPdfJson(pdfBytes);
const packagePdfJson = await inspectPdfJson(pdfBytes);
if (packagePdfJson !== directPdfJson || packagePdfJson !== nodePdfJson) {
  throw new Error("Node and wasm PDF inspection results are not exact");
}
let directPdfError;
let packagePdfError;
try {
  binding.inspectPdfJson(new Uint8Array([0]));
} catch (error) {
  directPdfError = String(error?.message ?? error);
}
let nodePdfError;
try {
  nodeBinding.inspectPdfJson(new Uint8Array([0]));
} catch (error) {
  nodePdfError = String(error?.message ?? error);
}
try {
  await inspectPdfJson(new Uint8Array([0]));
} catch (error) {
  packagePdfError = String(error?.message ?? error);
}
if (
  !directPdfError ||
  packagePdfError !== directPdfError ||
  nodePdfError !== directPdfError
) {
  throw new Error("Node and wasm PDF inspection error behavior is not exact");
}

const version = await nativePackageVersion();
if (typeof version !== "string" || version.length === 0) {
  throw new Error("native_package_version() did not return a version string");
}

// The bundled default package URL must resolve to a real file in the tarball.
const resolvedDefault = fileURLToPath(defaultPackageUrl());
if (!existsSync(resolvedDefault)) {
  throw new Error(
    `defaultPackageUrl() does not resolve to a file: ${resolvedDefault}`,
  );
}

const packageBytes = new Uint8Array(readFileSync(defaultPackagePath));
const wasmPrepared =
  binding.NativePreparedSearch.fromPreparedPackageBytes(packageBytes);
const nodePrepared =
  nodeBinding.NativePreparedSearch.fromPreparedPackageBytes(packageBytes);
for (const [label, prepared] of [
  ["wasm prepared search", wasmPrepared],
  ["node prepared search", nodePrepared],
]) {
  assertFunctionMembers(
    label,
    prepared,
    NATIVE_BINDING_PARITY_MEMBERS.prepared,
  );
  const session = prepared.createRedactionSession(
    `${label.replaceAll(" ", "_")}_1`,
  );
  assertFunctionMembers(
    `${label} session`,
    session,
    NATIVE_BINDING_PARITY_MEMBERS.session,
  );
  const plan = session.planStaticEntitiesWithCallerDetections({ inputs: [] });
  assertFunctionMembers(
    `${label} plan`,
    plan,
    NATIVE_BINDING_PARITY_MEMBERS.plan,
  );
}
const pipeline = await loadPipeline(packageBytes);

const sample = "A contract was signed by Jan Novak at Praha on 1. 1. 2025.";
const result = pipeline.redactText(sample);
const entities = result.resolvedEntities;

if (!Array.isArray(entities) || entities.length === 0) {
  throw new Error("wasm package entry did not detect any entity");
}

for (const { start, end, text } of entities) {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > sample.length ||
    sample.slice(start, end) !== text
  ) {
    throw new Error(
      `entity offsets do not round-trip: [${start}, ${end}) => "${sample.slice(start, end)}" != "${text}"`,
    );
  }
}

// Default operators are reversible ("replace"), so deanonymise must reconstruct
// the original text from the redaction map.
const { redactedText, redactionMap } = result.redaction;
if (redactedText === sample) {
  throw new Error("redaction did not change the text");
}
const restored = deanonymise(redactedText, redactionMap);
if (restored !== sample) {
  throw new Error(
    `deanonymise did not restore the original text:\n  restored: ${restored}\n  original: ${sample}`,
  );
}

// loadDefaultPipeline() resolves the bundled package from its file: URL, which
// now reads through node:fs under Node. It must detect the same entities as the
// explicitly byte-loaded pipeline above.
const defaultPipeline = await loadDefaultPipeline();
const defaultEntities = defaultPipeline.redactText(sample).resolvedEntities;
if (!Array.isArray(defaultEntities) || defaultEntities.length === 0) {
  throw new Error("loadDefaultPipeline() did not detect any entity");
}
if (defaultEntities.length !== entities.length) {
  throw new Error(
    `loadDefaultPipeline() entity count ${defaultEntities.length} != byte-loaded ${entities.length}`,
  );
}
for (const city of ["Buenos Aires", "Monterrey"]) {
  const cityEntities = defaultPipeline.redactText(
    `Address: ${city}`,
  ).resolvedEntities;
  if (
    !cityEntities.some(
      ({ label, text }) => label === "address" && text === city,
    )
  ) {
    throw new Error(`all-language package did not detect city: ${city}`);
  }
}

// Regional locale tags fall back to the shipped base-language package: no
// en-us package is bundled, so this must load native-pipeline.en.stlanonpkg.
const regionalPipeline = await loadDefaultPipeline("en-US");
if (regionalPipeline.redactText(sample).resolvedEntities.length === 0) {
  throw new Error("loadDefaultPipeline('en-US') did not fall back to en");
}

console.log(
  JSON.stringify({
    event: "wasm-package-smoke",
    ok: true,
    nativeVersion: version,
    entityCount: entities.length,
    labels: entities.map((entity) => entity.label),
    deanonymiseRoundTrip: true,
    allLanguageCityScope: true,
    loadDefaultPipeline: true,
    regionalLanguageFallback: true,
    docxParity: true,
    pdfInspectionParity: true,
  }),
);

function minimalDocx(text) {
  return zipSync({
    "[Content_Types].xml": strToU8(
      `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<Relationships xmlns="${PACKAGE_RELATIONSHIPS_NAMESPACE}"><Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS_NAMESPACE}/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    "word/document.xml": strToU8(
      `<w:document xmlns:w="${WORD_NAMESPACE}"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    ),
  });
}

function assertFunctionMembers(label, value, members) {
  for (const member of members) {
    if (typeof value?.[member] !== "function") {
      throw new TypeError(`${label} is missing required member ${member}`);
    }
  }
}
