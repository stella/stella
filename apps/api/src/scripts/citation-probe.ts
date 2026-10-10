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
 * A reporter-citing jurisdiction is read from the document's AST, and its
 * lines report the references the extractor left unresolved, by reason.
 *
 *   AWS_REGION=eu-central-1 bun src/scripts/citation-probe.ts \
 *     --bucket <legal-corpus-bucket> [--sample 18] [--jurisdictions CZE,SVK,POL]
 */
import { Result } from "better-result";

import { readsUsReporterCitations } from "@stll/api-contract/us-reporter-citation";
import { chunk as chunkItems } from "@stll/concurrency/chunk";
import { fetchWithTimeout } from "@stll/fetch";

import { extractDecisionCitations } from "@/api/handlers/case-law/ingestion/citation-extractor";
import {
  countUnresolvedTargets,
  type UsCitationDiagnostics,
  type UsCitationOccurrence,
} from "@/api/handlers/case-law/ingestion/us-citation-occurrences";
import { zstdDecompressToString } from "@/api/lib/compression";
import { isRecord } from "@/api/lib/type-guards";
import {
  isBenign,
  standaloneCandidate,
} from "@/api/scripts/citation-probe-candidates";
import { citationCoverage } from "@/api/scripts/citation-probe-coverage";
import {
  CitationProbeS3ReadError,
  hasNoUsableDocuments,
  readAst,
} from "@/api/scripts/citation-probe-read";

const DEFAULT_JURISDICTIONS = ["CZE", "SVK", "POL"] as const;
const KEY_PREFIX = "legal-corpus/documents/jurisdiction=";

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
const JURISDICTIONS: readonly string[] =
  argValue("--jurisdictions")
    ?.split(",")
    .filter((code) => /^[A-Z]{3}$/u.test(code)) ?? DEFAULT_JURISDICTIONS;
if (JURISDICTIONS.length === 0) {
  console.error("citation-probe: --jurisdictions must list ISO alpha-3 codes");
  process.exit(2);
}

const CITATION_PROBE_CONCURRENCY = 8;

let s3Attempts = 0;
let s3Failures = 0;

/** Run thunks with bounded concurrency, tolerating individual failures. */
const settleInBatches = async <T>(
  thunks: readonly (() => Promise<T>)[],
): Promise<T[]> => {
  const results: T[] = [];
  let failures = 0;
  const itemBatches = chunkItems(thunks, CITATION_PROBE_CONCURRENCY)[
    Symbol.iterator
  ]();
  const settleFrom = async (): Promise<void> => {
    const nextBatch = itemBatches.next();
    if (nextBatch.done) {
      return;
    }
    const batch = nextBatch.value;
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
    return settleFrom();
  };

  await settleFrom();
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
  // The runtime supplies an absolute path on the fixed credentials endpoint.
  if (!relativeUri?.startsWith("/")) {
    return null;
  }
  const response = await fetchWithTimeout(
    `http://169.254.170.2/${relativeUri.slice(1)}`,
    { timeoutMs: 5000 },
  );
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
  /** A reporter-citing decision whose AST could not be read. */
  unread: boolean;
  extractedCount: number;
  residuals: string[];
};

const readObject = async (key: string): Promise<string> => {
  // Keep the presigned fetch here because the probe requires a hard request
  // timeout; Bun's native S3 body reads do not yet accept an AbortSignal.
  // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- operator script; presigned by this script's own client, built from its fixed bucket and region config
  const response = await fetchWithTimeout(s3.presign(key, { expiresIn: 300 }), {
    timeoutMs: 30_000,
  });
  if (!response.ok) {
    throw new CitationProbeS3ReadError({
      message: `s3.get: failed with ${String(response.status)}`,
      status: response.status,
    });
  }
  return zstdDecompressToString(await response.bytes());
};

/**
 * A reporter jurisdiction's residuals, since broad detectors would only
 * re-find the references its extractor already located: the references it
 * left unresolved, by reason, and the authority spans no supported grammar
 * names, by kind.
 */
const abstentionLines = (
  occurrences: readonly UsCitationOccurrence[],
  diagnostics: UsCitationDiagnostics,
): string[] => [
  ...Object.entries(countUnresolvedTargets(occurrences)).flatMap(
    ([reason, count]) =>
      count === 0
        ? []
        : [
            `unresolved ${reason}: ${String(count)} of ${String(occurrences.length)}`,
          ],
  ),
  ...Object.entries(diagnostics.barriers).flatMap(([kind, count]) =>
    count === 0 ? [] : [`unsupported ${kind}: ${String(count)}`],
  ),
  ...(diagnostics.overlongPins === 0
    ? []
    : [`overlong pins: ${String(diagnostics.overlongPins)}`]),
];

const probeKey = async (
  jurisdiction: string,
  key: string,
): Promise<ProbedDoc> => {
  const text = await readObject(key);
  const documentId = key.slice(KEY_PREFIX.length).split("/").at(1) ?? key;
  if (text.trim().length === 0) {
    return {
      jurisdiction,
      documentId,
      empty: true,
      unread: false,
      extractedCount: 0,
      residuals: [],
    };
  }
  const astRead = readsUsReporterCitations(jurisdiction)
    ? await readAst(key, readObject)
    : null;
  if (astRead !== null && astRead.status !== "usable") {
    return {
      jurisdiction,
      documentId,
      empty: false,
      unread: true,
      extractedCount: 0,
      residuals: [`AST ${astRead.status}: citations not read`],
    };
  }
  const extraction = extractDecisionCitations({
    country: jurisdiction,
    sections: [{ index: 0, text }],
    documentAst: astRead?.ast,
  });
  if (Result.isError(extraction)) {
    return {
      jurisdiction,
      documentId,
      empty: false,
      unread: false,
      extractedCount: 0,
      residuals: [`rejected: ${extraction.error.message}`],
    };
  }
  const { citations: extracted, occurrences, reading } = extraction.value;
  if (reading.type !== "patterns") {
    return {
      jurisdiction,
      documentId,
      empty: false,
      unread: reading.type === "ast-unavailable",
      extractedCount: extracted.length,
      residuals:
        reading.type === "reporter-occurrences"
          ? abstentionLines(occurrences, reading.diagnostics)
          : ["AST unavailable: citations not read"],
    };
  }
  const covered = citationCoverage(extracted.map((c) => c.citationText));
  const residuals = new Set<string>();
  for (const detector of DETECTORS) {
    detector.lastIndex = 0;
    for (
      let match = detector.exec(text);
      match !== null;
      match = detector.exec(text)
    ) {
      const candidate = standaloneCandidate(match[0]);
      if (!covered(candidate) && !isBenign(candidate)) {
        residuals.add(candidate);
      }
    }
  }
  return {
    jurisdiction,
    documentId,
    empty: false,
    unread: false,
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
let sampledKeys = 0;
const docs = (
  await Promise.all(
    JURISDICTIONS.map(async (jurisdiction, i) => {
      const want = perJurisdiction[i] ?? 0;
      if (want === 0) {
        return [];
      }
      const keys = await sampleKeys(jurisdiction, want);
      sampledKeys += keys.length;
      return await settleInBatches(
        keys.map((key) => async () => await probeKey(jurisdiction, key)),
      );
    }),
  )
).flat();

let totalExtracted = 0;
let totalResiduals = 0;
let emptyDocs = 0;
let unreadDocs = 0;
for (const doc of docs) {
  if (doc.unread) {
    unreadDocs += 1;
  }
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
  `SUMMARY docs=${docs.length - emptyDocs} empty=${emptyDocs} ast-unread=${unreadDocs} extracted=${totalExtracted} residual-candidates=${totalResiduals}`,
);

// A run that sampled keys but read no usable document is a failure. An empty
// listing remains a reported collection shortfall rather than a probe failure.
if (hasNoUsableDocuments(sampledKeys, docs)) {
  console.error(
    `citation-probe: no usable documents probed (${String(sampledKeys)} sampled, ${s3Failures}/${s3Attempts} S3 operations failed); unusable run`,
  );
  process.exit(1);
}
