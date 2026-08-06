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
import { TaggedError } from "better-result";

import { extractCitations } from "@/api/handlers/case-law/ingestion/citation-extractor";
import { zstdDecompressToString } from "@/api/lib/compression";
import { fetchWithTimeout } from "@/api/lib/fetch";
import { isRecord } from "@/api/lib/type-guards";

const JURISDICTIONS = ["CZE", "SVK", "POL"] as const;
const KEY_PREFIX = "legal-corpus/documents/jurisdiction=";

class CitationProbeS3ReadError extends TaggedError("CitationProbeS3ReadError")<{
  message: string;
  status: number;
}> {}

const args = Bun.argv.slice(2);
const argValue = (name: string): string | undefined => {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
};

const bucket = argValue("--bucket");
if (!bucket) {
  console.error("citation-probe: --bucket is required");
  process.exit(2);
}
const sampleTarget = Number(argValue("--sample") ?? "18");
if (!Number.isInteger(sampleTarget) || sampleTarget <= 0 || sampleTarget > 60) {
  console.error("citation-probe: --sample must be an integer between 1 and 60");
  process.exit(2);
}

let s3Attempts = 0;
let s3Failures = 0;

/** Run thunks with bounded concurrency, tolerating individual failures. */
const settleInBatches = async <T>(
  thunks: readonly (() => Promise<T>)[],
): Promise<T[]> => {
  const results: T[] = [];
  let failures = 0;
  const settleFrom = async (offset: number): Promise<void> => {
    const batch = thunks.slice(offset, offset + 8);
    if (batch.length === 0) {
      return;
    }

    const settled = await Promise.allSettled(
      batch.map(async (thunk) => await thunk()),
    );
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        results.push(outcome.value);
      } else {
        failures += 1;
      }
    }
    return settleFrom(offset + 8);
  };

  await settleFrom(0);
  if (failures > 0) {
    console.error(
      `citation-probe: ${failures} S3 operations failed; continuing`,
    );
  }
  s3Attempts += thunks.length;
  s3Failures += failures;
  return results;
};

/** Race an S3 operation against a deadline so a stall cannot hang the probe. */
const withDeadline = async <T>(work: Promise<T>, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label}: timed out after 30s`)),
      30_000,
    );
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
};

type ResolvedCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

/**
 * Environment keys first (SSO exports, CI); otherwise the ECS container
 * credential endpoint, which is how a task role exposes its keys.
 */
const resolveCredentials = async (): Promise<ResolvedCredentials | null> => {
  const accessKeyId = Bun.env["AWS_ACCESS_KEY_ID"];
  const secretAccessKey = Bun.env["AWS_SECRET_ACCESS_KEY"];
  if (accessKeyId && secretAccessKey) {
    const sessionToken = Bun.env["AWS_SESSION_TOKEN"];
    return {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken ? { sessionToken } : {}),
    };
  }
  const relativeUri = Bun.env["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"];
  if (!relativeUri) {
    return null;
  }
  const response = await fetch(`http://169.254.170.2${relativeUri}`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    return null;
  }
  const body: unknown = await response.json();
  if (
    !isRecord(body) ||
    typeof body["AccessKeyId"] !== "string" ||
    typeof body["SecretAccessKey"] !== "string"
  ) {
    return null;
  }
  const token = body["Token"];
  return {
    accessKeyId: body["AccessKeyId"],
    secretAccessKey: body["SecretAccessKey"],
    ...(typeof token === "string" ? { sessionToken: token } : {}),
  };
};

const credentials = await resolveCredentials();
if (!credentials) {
  console.error(
    "citation-probe: no AWS credentials (env keys or container endpoint)",
  );
  process.exit(2);
}

const region = Bun.env["AWS_REGION"] ?? "eu-central-1";

const s3 = new Bun.S3Client({
  bucket,
  region,
  // Without an explicit endpoint the client signs against the wrong host
  // and session credentials are rejected.
  endpoint: `https://s3.${region}.amazonaws.com`,
  ...credentials,
});

// Broad candidate detectors. Noisy on purpose; benign filters and the
// covered-check prune them, and whatever survives is worth human review.
// Every quantifier is bounded so the scan stays linear (the repo ratchets
// super-linear regexes).
const DETECTORS: readonly RegExp[] = [
  /(?:sp\.\s{0,3}zn\.|sen\.\s{0,3}zn\.|sygn\.(?:\s{1,3}akt)?|[čc]\.\s{0,3}j\.:?)\s{0,3}[^,;()\n]{3,38}/gu,
  /\b(?:[IVX]{1,4}|Pl)\.?\s{0,3}ÚS[^,;()\n]{0,18}/gu,
  /\bECLI:[^\s,;)]{1,60}/gu,
  /\b[CTF][-‑–]\s{0,1}\d{1,4}\/\d{2,4}/gu,
];

// Residual classes that are not court decisions and never will be:
// administrative-authority file numbers (letter blocks joined by dashes),
// anonymization placeholders, and statute/collection references.
const BENIGN: readonly RegExp[] = [
  /[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]{2,8}[-–][\w/–-]{0,30}\d/u,
  /X{2,}/u,
  /\b\d{1,5}\/\d{2,4}\s{1,3}Sb\b/u,
  /\bZb\.\s*z\b/u,
  // Polish procurement-tribunal rulings (KIO/UZP): quasi-judicial, not a
  // court source the corpus ingests, so never a resolvable citation.
  /\bKIO ?\/? ?UZP\b/u,
  // KIO's own docket format ("KIO/2462/10", "KIO 2475 /10"): same
  // out-of-corpus tribunal, cited by case number rather than by name.
  /\bKIO\s{0,1}\/?\s{0,1}\d{1,5}\s{0,1}\/\s{0,1}\d{2,4}\b/u,
  // A case-number prefix ("sp. zn.", "sen. zn.", "sygn.[ akt]", "č. j.")
  // with no digit anywhere in the captured tail is never a real citation:
  // every actual docket carries a number. Covers Polish anonymization
  // placeholders, where the detector's own trailing-paren exclusion
  // truncates the candidate right before the redaction ("sygn. akt II Ca"
  // from "sygn. akt II Ca (…)"), and self-references such as "sygn. j.w."
  // ("as above").
  /^(?:sp\.\s{0,3}zn\.|sen\.\s{0,3}zn\.|sygn\.(?:\s{1,3}akt)?|[čc]\.\s{0,3}j\.:?)[^\d]{0,45}$/iu,
  // Administrative-authority "č. j." reference (tax office, land registry):
  // three or more purely numeric segments joined by slashes, e.g. "č. j.
  // 11055/01/332960/2959" (Finanční úřad), "č.j. 27662/97/332960/2959". A
  // real court docket always carries a letter registry between the chamber
  // digit and the docket number (CASE_NUMBER_BODY in the extractor); an
  // all-numeric multi-segment reference is never a court citation. The
  // lookahead excludes a following letter, digit, or slash so a longer or
  // mixed-format reference ("123/45/678/ABC", a 6-segment chain, or an
  // oversized final segment beyond the 6-digit cap) is never silently
  // truncated to a shorter benign-looking prefix.
  /[čc]\.\s{0,3}j\.:?\s{0,3}\d{1,6}(?:\/\d{1,6}){2,4}(?![\p{L}\d/])/u,
];

const isBenign = (candidate: string): boolean =>
  BENIGN.some((re) => re.test(candidate));

/** Uniform random UUID-shaped hex string (not crypto.randomUUID: the id
 * layout is irrelevant here, only its lexicographic position). */
const randomHexUuid = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const sampleKeys = async (jurisdiction: string, want: number) => {
  const prefix = `${KEY_PREFIX}${jurisdiction}/`;
  // The id space is mixed: database-defaulted rows carry uniform v4 ids
  // while application-minted rows carry time-prefixed v7 ids that cluster
  // lexicographically under `01…`. Half the cursors draw fully at random
  // (v4 region), half are pinned into the v7 era prefix; within each
  // region, sampling is proportional to key gaps, which for the
  // time-ordered v7 cluster approximates time-uniform. Over-draw and
  // deduplicate, since independent draws can land on the same document.
  const cursors = Array.from({ length: want * 3 }, (_, i) =>
    i % 2 === 0 ? randomHexUuid() : `019${randomHexUuid().slice(3)}`,
  );
  const listings = await settleInBatches(
    cursors.map(
      (cursor) => async () =>
        await withDeadline(
          s3.list({ prefix, startAfter: `${prefix}${cursor}`, maxKeys: 2 }),
          "s3.list",
        ),
    ),
  );
  const docPrefixes = new Set<string>();
  for (const listed of listings) {
    if (docPrefixes.size >= want) {
      break;
    }
    const landed = listed.contents?.at(0)?.key;
    if (landed) {
      docPrefixes.add(`${landed.split("/").slice(0, 4).join("/")}/`);
    }
  }
  // Enumerate each landed document's own prefix: three objects per
  // content version means a short window can miss the newest text
  // object entirely. Settled batches, so one failed enumeration costs
  // one document.
  const docListings = await settleInBatches(
    [...docPrefixes].map(
      (docPrefix) => async () =>
        await withDeadline(
          s3.list({ prefix: docPrefix, maxKeys: 64 }),
          "s3.list-doc",
        ),
    ),
  );
  const keys = new Set<string>();
  for (const docListing of docListings) {
    const contents = docListing.contents;
    if (!contents) {
      continue;
    }
    const textEntries = contents.filter((entry) =>
      entry.key.endsWith("/text.zst"),
    );
    // A backfilled document can leave an orphaned content-addressed
    // payload beside the live one. Newest-write is a heuristic, not a
    // guarantee (a compare-and-set-rejected write can be newer than the
    // live payload); resolving the truly live key would need the
    // database, which this probe deliberately avoids — and a superseded
    // payload is still real court prose, which is all pattern-mining
    // needs.
    const first = textEntries.at(0);
    if (first) {
      let newest = first;
      for (const entry of textEntries) {
        if ((entry.lastModified ?? "") > (newest.lastModified ?? "")) {
          newest = entry;
        }
      }
      keys.add(newest.key);
    }
  }
  return [...keys];
};

type ProbedDoc = {
  jurisdiction: string;
  documentId: string;
  empty: boolean;
  extractedCount: number;
  residuals: string[];
};

const probeKey = async (
  jurisdiction: string,
  key: string,
): Promise<ProbedDoc> => {
  // Presigned GET rather than `s3.file(key).bytes()`: the native read strands
  // its download buffer on every call (see `no-native-s3-object-read`). This
  // probe is short-lived enough not to care, but reading the same way as the
  // rest of the codebase keeps one path to revert when the runtime is fixed.
  const response = await fetchWithTimeout(s3.presign(key, { expiresIn: 300 }), {
    timeoutMs: 30_000,
  });
  if (!response.ok) {
    throw new CitationProbeS3ReadError({
      message: `s3.get: failed with ${String(response.status)}`,
      status: response.status,
    });
  }
  const body = await response.bytes();
  const text = zstdDecompressToString(body);
  const documentId = key.slice(KEY_PREFIX.length).split("/").at(1) ?? key;
  if (text.trim().length === 0) {
    return {
      jurisdiction,
      documentId,
      empty: true,
      extractedCount: 0,
      residuals: [],
    };
  }
  const extracted = extractCitations([{ index: 0, text }]);
  // Both sides normalize (prefix stripped, whitespace collapsed) before
  // the containment check: the extractor dedups sp. zn. and č. j.
  // spellings of one case number to a single entry, and the surviving
  // prefix must not decide coverage.
  const stripCitePrefix = (value: string): string =>
    value
      .replace(
        /^(?:sp\.\s{0,3}zn\.:?|sen\.\s{0,3}zn\.:?|sygn\.(?:\s{1,3}akt)?|[čc]\.\s{0,3}j\.:?)\s{0,3}/iu,
        "",
      )
      .replaceAll(/\s+/gu, " ")
      .toLowerCase()
      .trim();
  const extractedKeys = extracted.map((c) => stripCitePrefix(c.citationText));
  const covered = (candidate: string): boolean => {
    const candidateKey = stripCitePrefix(candidate);
    return extractedKeys.some(
      (have) => candidateKey.includes(have) || have.includes(candidateKey),
    );
  };
  const residuals = new Set<string>();
  for (const detector of DETECTORS) {
    detector.lastIndex = 0;
    for (
      let match = detector.exec(text);
      match !== null;
      match = detector.exec(text)
    ) {
      let candidate = match[0].replaceAll(/\s+/gu, " ").trim();
      // A greedy tail can swallow a second prefixed reference into one
      // candidate, hiding it behind the first one's coverage; cut the
      // candidate at any embedded prefix so each reference stands alone.
      const embedded = candidate
        .slice(4)
        .search(/(?:sp\.\s?zn\.|sen\.\s?zn\.|sygn\.|[čc]\.\s?j\.)/iu);
      if (embedded !== -1) {
        candidate = candidate.slice(0, embedded + 4).trim();
      }
      if (!covered(candidate) && !isBenign(candidate)) {
        residuals.add(candidate);
      }
    }
  }
  return {
    jurisdiction,
    documentId,
    empty: false,
    extractedCount: extracted.length,
    residuals: [...residuals],
  };
};

// Distribute the requested total across jurisdictions, remainder to the
// front, so --sample means what it says.
const perJurisdiction = JURISDICTIONS.map((_, i) => {
  const base = Math.floor(sampleTarget / JURISDICTIONS.length);
  return base + (i < sampleTarget % JURISDICTIONS.length ? 1 : 0);
});
const docs = (
  await Promise.all(
    JURISDICTIONS.map(async (jurisdiction, i) => {
      const want = perJurisdiction[i] ?? 0;
      if (want === 0) {
        return [];
      }
      const keys = await sampleKeys(jurisdiction, want);
      return await settleInBatches(
        keys.map((key) => async () => await probeKey(jurisdiction, key)),
      );
    }),
  )
).flat();

let totalExtracted = 0;
let totalResiduals = 0;
let emptyDocs = 0;
for (const doc of docs) {
  if (doc.empty) {
    emptyDocs += 1;
    continue;
  }
  totalExtracted += doc.extractedCount;
  totalResiduals += doc.residuals.length;
  if (doc.residuals.length > 0) {
    console.log(`RESIDUAL ${doc.jurisdiction} ${doc.documentId}`);
    for (const residual of doc.residuals.slice(0, 6)) {
      console.log(`  ${residual}`);
    }
  }
}

console.log(
  `SUMMARY docs=${docs.length - emptyDocs} empty=${emptyDocs} extracted=${totalExtracted} residual-candidates=${totalResiduals}`,
);

// A run whose sampled documents are all empty is a failure. An empty listing
// remains a reported collection shortfall rather than a false probe failure.
if (docs.length > 0 && docs.every((doc) => doc.empty)) {
  console.error(
    `citation-probe: no usable documents probed (${docs.length} sampled, ${s3Failures}/${s3Attempts} S3 operations failed); unusable run`,
  );
  process.exit(1);
}
