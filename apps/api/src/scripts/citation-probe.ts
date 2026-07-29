/**
 * Random-sample citation probe: how much citation-shaped text does the
 * extractor miss in real decisions?
 *
 * Samples decisions straight from the corpus bucket (uniform over document
 * ids via random-UUID `startAfter` listing, no database needed), runs the
 * production extractor, then a set of deliberately broad citation-ish
 * detectors, and reports only the residuals no benign filter explains. The
 * output is intentionally compact: a scheduled reviewer reads residual
 * lines, not decisions.
 *
 *   AWS_REGION=eu-central-1 bun src/scripts/citation-probe.ts \
 *     --bucket <legal-corpus-bucket> [--sample 18]
 */
import { extractCitations } from "@/api/handlers/case-law/ingestion/citation-extractor";
import { zstdDecompressToString } from "@/api/lib/compression";

const JURISDICTIONS = ["CZE", "SVK", "POL"] as const;
const KEY_PREFIX = "legal-corpus/documents/jurisdiction=";

const args = Bun.argv.slice(2);
const argValue = (name: string): string | undefined => {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
};

const bucket = argValue("--bucket");
if (!bucket) {
  console.error("citation-probe: --bucket is required");
  process.exit(2);
}
const sampleTarget = Number(argValue("--sample") ?? "18");
if (!Number.isInteger(sampleTarget) || sampleTarget <= 0) {
  console.error("citation-probe: --sample must be a positive integer");
  process.exit(2);
}

// Explicit credential plumbing: the client's environment inference does
// not cover session credentials (SSO, task roles), which carry a token.
const credentialEnv = {
  ...(Bun.env["AWS_ACCESS_KEY_ID"]
    ? { accessKeyId: Bun.env["AWS_ACCESS_KEY_ID"] }
    : {}),
  ...(Bun.env["AWS_SECRET_ACCESS_KEY"]
    ? { secretAccessKey: Bun.env["AWS_SECRET_ACCESS_KEY"] }
    : {}),
  ...(Bun.env["AWS_SESSION_TOKEN"]
    ? { sessionToken: Bun.env["AWS_SESSION_TOKEN"] }
    : {}),
};

const region = Bun.env["AWS_REGION"] ?? "eu-central-1";

const s3 = new Bun.S3Client({
  bucket,
  region,
  // Without an explicit endpoint the client signs against the wrong host
  // and session credentials are rejected.
  endpoint: `https://s3.${region}.amazonaws.com`,
  ...credentialEnv,
});

// Broad candidate detectors. Noisy on purpose; benign filters and the
// covered-check prune them, and whatever survives is worth human review.
const DETECTORS: readonly RegExp[] = [
  /(?:sp\.\s*zn\.|sen\.\s*zn\.|sygn\.\s*(?:akt\s+)?|[čc]\.\s*j\.:?)\s*[^\s,;()][^,;()\n]{2,38}/gu,
  /\b(?:[IVX]{1,4}|Pl)\.?\s*ÚS[^,;()\n]{0,18}/gu,
  /\bECLI:[^\s,;)]+/gu,
  /\b[CTF][-‑–]\s?\d{1,4}\/\d{2,4}/gu,
];

// Residual classes that are not court decisions and never will be:
// administrative-authority file numbers (letter blocks joined by dashes),
// anonymization placeholders, and statute/collection references.
const BENIGN: readonly RegExp[] = [
  /[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]{2,}[-–][\w/–-]*\d/u,
  /X{2,}/u,
  /\d+\/\d+\s+Sb\b/u,
  /\bZb\.\s*z\b/u,
  // Polish procurement-tribunal rulings (KIO/UZP): quasi-judicial, not a
  // court source the corpus ingests, so never a resolvable citation.
  /\bKIO\s*\/?\s*UZP\b/u,
];

const isBenign = (candidate: string): boolean =>
  BENIGN.some((re) => re.test(candidate));

const sampleKeys = async (jurisdiction: string, want: number) => {
  const keys: string[] = [];
  const prefix = `${KEY_PREFIX}${jurisdiction}/`;
  let guard = 0;
  while (keys.length < want && guard < want * 4) {
    guard += 1;
    // A random v4 UUID as the listing cursor is a uniform draw over the
    // id space; v7 would be time-prefixed and collapse every draw onto
    // the most recent documents.
    const listed = await s3.list({
      prefix,
      startAfter: `${prefix}${crypto.randomUUID()}`,
      maxKeys: 8,
    });
    const textKey = listed.contents?.find((entry) =>
      entry.key.endsWith("/text.zst"),
    )?.key;
    if (textKey && !keys.includes(textKey)) {
      keys.push(textKey);
    }
  }
  return keys;
};

let totalDocs = 0;
let totalExtracted = 0;
let totalResiduals = 0;
let emptyDocs = 0;

for (const jurisdiction of JURISDICTIONS) {
  const want = Math.max(1, Math.floor(sampleTarget / JURISDICTIONS.length));
  // oxlint-disable-next-line no-await-in-loop -- sequential per-jurisdiction sampling keeps S3 pressure trivial
  const keys = await sampleKeys(jurisdiction, want);
  for (const key of keys) {
    // oxlint-disable-next-line no-await-in-loop -- one object at a time; the probe favors simplicity over speed
    const body = await s3.file(key).bytes();
    const text = zstdDecompressToString(body);
    if (text.trim().length === 0) {
      emptyDocs += 1;
      continue;
    }
    const extracted = extractCitations([{ index: 0, text }]);
    const covered = (candidate: string): boolean =>
      extracted.some(
        (c) =>
          candidate.includes(c.citationText) ||
          c.citationText.includes(candidate),
      );
    const residuals = new Set<string>();
    for (const detector of DETECTORS) {
      detector.lastIndex = 0;
      for (
        let match = detector.exec(text);
        match !== null;
        match = detector.exec(text)
      ) {
        const candidate = match[0].replaceAll(/\s+/gu, " ").trim();
        if (!covered(candidate) && !isBenign(candidate)) {
          residuals.add(candidate);
        }
      }
    }
    totalDocs += 1;
    totalExtracted += extracted.length;
    totalResiduals += residuals.size;
    const documentId = key.slice(KEY_PREFIX.length).split("/").at(1) ?? key;
    if (residuals.size > 0) {
      console.log(`RESIDUAL ${jurisdiction} ${documentId}`);
      for (const residual of [...residuals].slice(0, 6)) {
        console.log(`  ${residual}`);
      }
    }
  }
}

console.log(
  `SUMMARY docs=${totalDocs} empty=${emptyDocs} extracted=${totalExtracted} residual-candidates=${totalResiduals}`,
);
