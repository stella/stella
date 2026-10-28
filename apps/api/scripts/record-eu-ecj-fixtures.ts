/**
 * Record the eu-ecj fixtures from Cellar.
 *
 * Writes two things, both from one pass over the same decisions:
 *
 * 1. Parser fixtures (`parsers/__fixtures__/eu-ecj/`): the XHTML the
 *    adapter fetched, paired with the Formex XML of the same document.
 *    Formex is the Publications Office's semantic encoding — it states
 *    heading levels, paragraph numbers and the keyword chain outright —
 *    so the parser's reading of the class-annotated XHTML can be
 *    checked against the publisher rather than against itself. The
 *    decisions in `PORTAL_CORPUS` get a second recording in the same
 *    pass: the page encoding of the same converter output, written only
 *    together with the manifestation it is compared against.
 * 2. Notice fixtures (`adapters/__fixtures__/`): the branch notice the
 *    repository serves for one work, recorded once per language, which is
 *    what the conformance suites drive the adapter's envelope with.
 * 3. The seed fixture (`scripts/__fixtures__/case-law/eu-ecj.json.gz`) in
 *    the shape `seed-case-law.ts` loads.
 *
 * Both come from `fetchDecisionsByCelex`, the adapter's own query and
 * parse path, so a fixture cannot drift from what ingestion produces.
 * Do not hand-edit the outputs; re-run this instead.
 *
 * Fixtures are gzipped: they are generated artifacts, several hundred
 * kilobytes each as text, and never read by eye.
 *
 * Usage:
 *   bun apps/api/scripts/record-eu-ecj-fixtures.ts
 *   bun apps/api/scripts/record-eu-ecj-fixtures.ts --parser-only
 *   bun apps/api/scripts/record-eu-ecj-fixtures.ts --parser-only --celex 61990CJ0006
 *   bun apps/api/scripts/record-eu-ecj-fixtures.ts --notice-only
 *   bun apps/api/scripts/record-eu-ecj-fixtures.ts --seed-only
 */

import { panic } from "better-result";
import path from "node:path";

import { ZipArchive } from "@stll/docx-core/zip";
import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import {
  ecjEnvelopeDocument,
  fetchDecisionsByCelex,
} from "@/api/handlers/case-law/ingestion/adapters/eu-ecj";
import { INGESTION_USER_AGENT } from "@/api/handlers/case-law/ingestion/adapters/utils";
import {
  manifestationStem,
  PORTAL_CORPUS,
  PORTAL_DOCUMENT_CONTAINER,
  type PortalPair,
  portalStem,
} from "@/api/handlers/case-law/ingestion/parsers/__fixtures__/eu-ecj/corpus";
import { parseFormex } from "@/api/handlers/case-law/ingestion/parsers/eu-ecj-formex";
import { encodeGzipJson } from "@/api/lib/gzip-json";

import {
  formatProvenance,
  provenancePathOf,
} from "../src/tests/fixture-provenance";
import { seedId } from "./seed-utils";

/**
 * Parser corpus. Each entry earns its place by exercising a structural
 * feature that broke, or could break, the parser; the language column
 * is about typography and numbering, not about translation quality.
 */
const PARSER_CORPUS = [
  {
    celex: "62018CJ0311",
    languages: ["EN", "LV"],
    why: "Schrems II: the long judgment, with quoted legislation nested inside numbered paragraphs, a five-item operative part and a full signature block. LV additionally has a keyword that itself contains a spaced dash, which is the separator everywhere else.",
  },
  {
    celex: "62022CJ0128",
    languages: ["EL", "EN"],
    why: "Judgment in a non-Latin script, with guillemets rather than parentheses around the keyword chain. Shorter than Schrems II, which is the point: script coverage does not need document length. EN is the baseline the portal-page recording of the same decision is compared against.",
  },
  {
    celex: "62018CC0311",
    languages: ["FI"],
    why: "Advocate General opinion: no heading classes at all, a six-level outline that switches from bold to italic with depth, and 220 footnotes. Finnish numbers its sections without a trailing period, so the depth cannot be read off punctuation.",
  },
  {
    celex: "62013TO0488",
    languages: ["CS"],
    why: "The oldest XHTML layout, which wraps the whole decision in `div.listNotice > div.texte` and uses anchor links rather than classes for its sections. It collapsed into a single block until containers were flattened, and its operative part is only classified correctly if flattening also assigns document-wide positions.",
  },
  {
    celex: "62023CO0786",
    languages: ["EN"],
    why: "Order: the short form of the judgment layout, and the smallest complete document in the corpus.",
  },
  {
    celex: "62017CJ0258",
    languages: ["PL"],
    why: "Converted by the pre-version-9 pipeline, which spells the whole class vocabulary without the `coj-` prefix (`normal`, `count`, `sum-title-1`). Roughly everything published before 2019 looks like this, and it parsed to a structureless wall of text until the parser accepted both spellings.",
  },
  {
    celex: "62023TJ0201",
    languages: ["EN"],
    why: "General Court judgment: a different signature block (per-judge cells rather than one [Signatures] line).",
  },
  {
    celex: "61990CJ0006",
    languages: ["EN"],
    why: "Oldest layout from the 1990s: paragraph numbers printed as text (`37 It follows`), sub-headings as plain paragraphs between them, a contents line of in-document links before the parties, and the sections (parties, grounds, costs, operative part) named only by the publisher's anchors.",
  },
  {
    celex: "61978CJ0120",
    languages: ["EN"],
    why: "Oldest layout as typeset in the 1970s: the number is glued to the paragraph (`1BY ORDER OF`), and a quoted question inside a paragraph opens with `1 .`, which is not the Court's numbering.",
  },
  {
    celex: "61955CJ0008",
    languages: ["DA", "EN"],
    why: "A 1956 judgment. DA is converter output whose operative part and summary each restart `pointN` at 1, so the publisher's anchors repeat. EN is the oldest layout with printed report page markers (`P . 255`) as paragraphs and no paragraph numbers at all.",
  },
  {
    celex: "62004CJ0144",
    languages: ["HU"],
    why: "Oldest layout in a language where headings carry no marker (`Jogi háttér`), among quoted lists whose items end in punctuation.",
  },
  {
    celex: "62019CO0791",
    languages: ["EN"],
    why: "Interim-measures order: its operative part follows the last reasoning heading with no heading of its own, and its reasoning quotes numbered lists (`1) disciplinary proceedings:`).",
  },
] as const;

/**
 * Decisions seeded into a dev database, and shown in the reader.
 *
 * Deliberately smaller than the parser corpus. `seed-case-law.ts`
 * derives a decision's seed id from adapter, case number and language,
 * so a case's judgment and the Advocate General's opinion on it would
 * collide; opinions are covered by the parser corpus instead. The order
 * is here twice to give the reader's language switcher something to
 * switch between at a fraction of a judgment's size.
 */
const SEED_CORPUS = [
  { celex: "62018CJ0311", languages: ["EN"] },
  { celex: "62023CO0786", languages: ["EN", "FR"] },
] as const;

export const hashRecordedFixtureBytes = (bytes: Uint8Array) =>
  hashSha256Hex(bytes);

const PARSER_FIXTURES_DIR = new URL(
  "../src/handlers/case-law/ingestion/parsers/__fixtures__/eu-ecj/",
  import.meta.url,
);
const SEED_FIXTURE = new URL(
  "__fixtures__/case-law/eu-ecj.json.gz",
  import.meta.url,
);

const SPARQL_URL = "https://publications.europa.eu/webapi/rdf/sparql";
const FETCH_TIMEOUT_MS = 120_000;

const log = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

// ── Formex, for the oracle ─────────────────────────────────

/** Formex roots that encode the decision itself. */
const ORACLE_KINDS = new Set(["JUDGMENT", "ORDER", "CONCLUSION"]);

/**
 * Resolve a decision's Formex manifestation and download it. Cellar
 * serves it either directly or wrapped in a zip, depending on how the
 * document was published, and negotiates on an exact media type.
 */
/** A Formex manifestation and the Cellar URL it was served from. */
type FormexCapture = { bytes: Uint8Array; sourceUrl: string };

const fetchFormex = async (
  celex: string,
  languageUri: string,
): Promise<FormexCapture | undefined> => {
  const query = `
PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
SELECT DISTINCT ?manifestation WHERE {
  ?doc cdm:resource_legal_id_celex "${celex}"^^<http://www.w3.org/2001/XMLSchema#string> .
  ?expression cdm:expression_belongs_to_work ?doc .
  ?expression cdm:expression_uses_language <${languageUri}> .
  ?manifestation cdm:manifestation_manifests_expression ?expression .
  ?manifestation cdm:manifestation_type ?type .
  FILTER(STR(?type) = "fmx4")
}`.trim();

  const response = await fetch(SPARQL_URL, {
    method: "POST",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      Accept: "application/sparql-results+json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": INGESTION_USER_AGENT,
    },
    body: new URLSearchParams({ query }).toString(),
  });

  if (!response.ok) {
    return undefined;
  }

  const payload: unknown = await response.json();
  const uri = firstManifestationUri(payload);
  if (uri === undefined) {
    return undefined;
  }

  const contentUrl = `${uri.replace("http://", "https://")}/DOC_1`;
  const typed = await fetch(contentUrl, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      Accept: "application/xml;type=fmx4",
      "User-Agent": INGESTION_USER_AGENT,
    },
  });
  if (typed.ok) {
    return {
      bytes: new Uint8Array(await typed.arrayBuffer()),
      sourceUrl: contentUrl,
    };
  }

  const zipped = await fetch(contentUrl, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Accept: "application/zip", "User-Agent": INGESTION_USER_AGENT },
  });
  if (!zipped.ok) {
    return undefined;
  }
  const entry = await unzipSingleEntry(
    new Uint8Array(await zipped.arrayBuffer()),
  );
  return entry === undefined
    ? undefined
    : { bytes: entry, sourceUrl: contentUrl };
};

const firstManifestationUri = (payload: unknown): string | undefined => {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const results = Reflect.get(payload, "results");
  if (typeof results !== "object" || results === null) {
    return undefined;
  }
  const bindings = Reflect.get(results, "bindings");
  if (!Array.isArray(bindings)) {
    return undefined;
  }
  for (const binding of bindings) {
    if (typeof binding !== "object" || binding === null) {
      continue;
    }
    const manifestation = Reflect.get(binding, "manifestation");
    if (typeof manifestation !== "object" || manifestation === null) {
      continue;
    }
    const value = Reflect.get(manifestation, "value");
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
};

/** Read the single entry out of a Cellar zip container. */
const unzipSingleEntry = async (
  archive: Uint8Array,
): Promise<Uint8Array | undefined> => {
  const zip = await ZipArchive.read(archive);
  const entry = zip.entries().at(0);
  return await entry?.bytes();
};

// ── Recording ──────────────────────────────────────────────

const languageUriOf = (decision: IngestionResult): string => {
  const uri = decision.metadata["languageUri"];
  return typeof uri === "string" ? uri : "";
};

const celexOf = (decision: IngestionResult): string => {
  const celex = decision.metadata["celex"];
  return typeof celex === "string" ? celex : "";
};

/**
 * One fixture file, held back until its whole group is in hand.
 *
 * `sourceUrl` is carried per fixture rather than derived at write time:
 * the three kinds of recording come from three different URLs (the
 * decision's own manifestation, its Formex sibling in Cellar, the portal
 * page), and a sidecar naming the wrong one is worse than none.
 */
type StagedFixture = {
  name: string;
  bytes: Uint8Array;
  sourceUrl: string;
};

/**
 * Outcome of asking the portal for the page half of a pair.
 *
 * Carried back rather than logged where it happens, because the caller
 * is what knows which decision was being recorded — and, more to the
 * point, what has to decide that nothing gets written.
 */
type PortalFetch =
  | { outcome: "served"; html: string }
  | { outcome: "no-url" }
  | { outcome: "no-document"; httpStatus: number };

const fetchPortalPage = async (
  decision: IngestionResult,
): Promise<PortalFetch> => {
  const url = decision.sourceUrl;
  if (url === undefined) {
    return { outcome: "no-url" };
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "User-Agent": INGESTION_USER_AGENT },
  });
  // The portal answers an automated request with a challenge page under
  // a success status, so the container, not the status, is what says a
  // document arrived.
  const html = response.ok ? await response.text() : "";
  return html.includes(PORTAL_DOCUMENT_CONTAINER)
    ? { outcome: "served", html }
    : { outcome: "no-document", httpStatus: response.status };
};

const portalFailureReason = (
  failure: Exclude<PortalFetch, { outcome: "served" }>,
): string => {
  switch (failure.outcome) {
    case "no-url":
      return "the query returned no portal URL";
    case "no-document":
      return `the portal served no document (${failure.httpStatus})`;
    default:
      failure satisfies never;
      return panic(`Unhandled failure: ${String(failure)}`);
  }
};

const portalPairFor = (stem: string): PortalPair | undefined =>
  PORTAL_CORPUS.find((pair) => manifestationStem(pair) === stem);

/**
 * Record the parser corpus, and the portal encoding of the decisions
 * declared as pairs alongside it.
 *
 * A pair's two halves are one converter output, and the test that
 * compares them holds them to that, so they may never come from
 * different runs: the publisher can revise a document between two
 * fetches, and the comparison would then be measuring the revision
 * rather than the parse. Both halves are therefore fetched and checked
 * before either is written, and a portal fetch that returns no document
 * leaves the pair exactly as it was.
 */
const recordParserFixtures = async (
  only: readonly string[] | undefined,
): Promise<void> => {
  for (const { celex, languages } of PARSER_CORPUS) {
    if (only !== undefined && !only.includes(celex)) {
      continue;
    }
    const decisions = await fetchDecisionsByCelex({
      celexNumbers: [celex],
      languages,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS * languages.length),
    });

    for (const decision of decisions) {
      const stem = `${celex}.${decision.language}`;
      // The result stores an envelope of every response fetched for the
      // variant; the parser fixture is the manifestation alone.
      const xhtml =
        decision.sourceRaw === undefined
          ? undefined
          : ecjEnvelopeDocument(decision.sourceRaw);
      if (xhtml === undefined) {
        log(`  ${stem}: no XHTML, skipped`);
        continue;
      }
      // The XHTML bytes were fetched from the Cellar manifestation
      // (`documentUrl`), not from the EUR-Lex portal page (`sourceUrl`);
      // provenance names the former. A recording whose manifestation the
      // query did not return is skipped rather than written with the
      // portal URL standing in.
      if (decision.documentUrl === undefined) {
        log(`  ${stem}: no manifestation URL, skipped`);
        continue;
      }

      const staged: StagedFixture[] = [
        {
          name: `${stem}.html.gz`,
          bytes: Bun.gzipSync(Buffer.from(xhtml)),
          sourceUrl: decision.documentUrl,
        },
      ];

      const formex = await fetchFormex(celex, languageUriOf(decision));
      const formexKind =
        formex === undefined
          ? undefined
          : parseFormex(new TextDecoder().decode(formex.bytes)).kind;
      if (formex === undefined) {
        log(`  ${stem}: no Formex published`);
      } else if (!ORACLE_KINDS.has(formexKind ?? "")) {
        // The oldest works' Formex can be another document of the case
        // (the report for the hearing, the summary), which states nothing
        // about this one's structure and would mislead the oracle.
        log(`  ${stem}: Formex is a ${formexKind ?? "?"}, not the decision`);
      } else {
        staged.push({
          name: `${stem}.fmx.xml.gz`,
          bytes: Bun.gzipSync(new Uint8Array(formex.bytes)),
          sourceUrl: formex.sourceUrl,
        });
      }

      const pair = portalPairFor(stem);
      if (pair !== undefined) {
        // The portal page, unlike the manifestation, is what `sourceUrl`
        // names; a decision without one cannot record its pair honestly.
        if (decision.sourceUrl === undefined) {
          log(`  ${stem}: no portal URL, pair left as recorded`);
          continue;
        }
        const portal = await fetchPortalPage(decision);
        if (portal.outcome !== "served") {
          log(
            `  ${stem}: ${portalFailureReason(portal)}, pair left as recorded`,
          );
          continue;
        }
        staged.push({
          name: `${portalStem(pair)}.html.gz`,
          bytes: Bun.gzipSync(Buffer.from(portal.html)),
          sourceUrl: decision.sourceUrl,
        });
      }

      const capturedAt = new Date().toISOString();
      for (const { name, bytes, sourceUrl } of staged) {
        // The sidecar pins the bytes written beside it; fixture-provenance
        // rechecks the hash on every test run, so a recording and its
        // provenance can never be committed apart.
        await Promise.all([
          Bun.write(new URL(name, PARSER_FIXTURES_DIR), bytes),
          Bun.write(
            new URL(provenancePathOf(name), PARSER_FIXTURES_DIR),
            formatProvenance({
              capture: "recorded",
              sha256: hashRecordedFixtureBytes(bytes),
              sourceUrl,
              capturedAt,
            }),
          ),
        ]);
      }
      log(`  ${stem}: ${staged.map((fixture) => fixture.name).join(", ")}`);
    }
  }
};

// ── The adapter's own envelope parts ───────────────────────

/**
 * The branch notice, in the language of one expression.
 *
 * Recorded twice for the same decision, in two languages, because that is
 * what the conformance suites are held to: a row is one expression, and the
 * notice renders the title, the docket wording and every concept label into
 * the language it was negotiated for. One capture could not show that.
 */
const NOTICE_CORPUS = [
  { celex: "62022CJ0128", cellarLanguage: "eng", stem: "eu-ecj-notice-en" },
  { celex: "62022CJ0128", cellarLanguage: "ell", stem: "eu-ecj-notice-el" },
] as const;

const ADAPTER_FIXTURES_DIR = new URL(
  "../src/handlers/case-law/ingestion/adapters/__fixtures__/",
  import.meta.url,
);

type NoticeCapture = (typeof NOTICE_CORPUS)[number];

const recordNotice = async ({
  celex,
  cellarLanguage,
  stem,
}: NoticeCapture): Promise<void> => {
  const sourceUrl = `https://publications.europa.eu/resource/celex/${celex}`;
  const response = await fetch(sourceUrl, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      Accept: "application/xml; notice=branch",
      "Accept-Language": cellarLanguage,
      "User-Agent": INGESTION_USER_AGENT,
    },
  });
  if (!response.ok) {
    log(`  ${stem}: no notice served (${response.status})`);
    return;
  }

  const name = `${stem}.xml.gz`;
  const bytes = Bun.gzipSync(Buffer.from(await response.text()));
  await Promise.all([
    Bun.write(new URL(name, ADAPTER_FIXTURES_DIR), bytes),
    Bun.write(
      new URL(provenancePathOf(name), ADAPTER_FIXTURES_DIR),
      formatProvenance({
        capture: "recorded",
        sha256: hashRecordedFixtureBytes(bytes),
        sourceUrl,
        capturedAt: new Date().toISOString(),
        note: `branch notice, Accept-Language: ${cellarLanguage}`,
      }),
    ),
  ]);
  log(`  ${stem}: ${name}`);
};

/**
 * One notice after another.
 *
 * Recursive rather than a loop, as the adapter's own address walk is: a
 * recording spends the publisher's budget the way a crawl does, and asking
 * for two notices of one work at once is not that.
 */
const recordNoticeFixtures = async (
  remaining: readonly NoticeCapture[] = NOTICE_CORPUS,
): Promise<void> => {
  const [capture, ...rest] = remaining;
  if (capture === undefined) {
    return;
  }
  await recordNotice(capture);
  await recordNoticeFixtures(rest);
};

/** Row shape `seed-case-law.ts` reads. */
const toSeedRow = (decision: IngestionResult, sourceId: string) => ({
  id: seedId(`case-law-dec-eu-ecj-${decision.caseNumber}-${decision.language}`),
  ecli: decision.ecli ?? null,
  slug: null,
  court: decision.court,
  country: decision.country,
  analysis: null,
  fulltext: decision.fulltext ?? null,
  language: decision.language,
  metadata: decision.metadata,
  sections: decision.sections ?? null,
  source_id: sourceId,
  source_raw: null,
  source_url: decision.sourceUrl ?? null,
  case_number: decision.caseNumber,
  source_hash: decision.rawHash,
  document_ast: decision.documentAst,
  document_url: decision.documentUrl ?? null,
  decision_date: decision.decisionDate ?? null,
  decision_type: decision.decisionType ?? null,
  parser_version: decision.parserVersion ?? null,
  source_raw_s3_key: null,
  language_group_key: decision.ecli ?? null,
  source_raw_content_type: null,
});

const recordSeedFixture = async (): Promise<void> => {
  const sourceId = seedId("case-law-source-eu-ecj");
  const rows: ReturnType<typeof toSeedRow>[] = [];

  for (const { celex, languages } of SEED_CORPUS) {
    const decisions = await fetchDecisionsByCelex({
      celexNumbers: [celex],
      languages,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS * languages.length),
    });
    for (const decision of decisions) {
      rows.push(toSeedRow(decision, sourceId));
      log(`  ${celexOf(decision)}.${decision.language}: seeded`);
    }
  }

  await Bun.write(
    SEED_FIXTURE,
    encodeGzipJson({
      source: {
        id: sourceId,
        name: "Court of Justice of the EU (CJEU)",
        config: {},
        enabled: true,
        adapter_key: "eu-ecj",
      },
      decisions: rows,
    }),
  );
};

if (import.meta.main) {
  const parserOnly = process.argv.includes("--parser-only");
  const seedOnly = process.argv.includes("--seed-only");
  const noticeOnly = process.argv.includes("--notice-only");
  const only = parserOnly || seedOnly || noticeOnly;
  // `--celex 61990CJ0006,61978CJ0120` records only those parser-corpus
  // entries, so adding a decision does not re-record the rest.
  const celexIndex = process.argv.indexOf("--celex");
  const celexOnly =
    celexIndex === -1
      ? undefined
      : (process.argv[celexIndex + 1] ?? "").split(",").filter(Boolean);

  if (parserOnly || !only) {
    log(
      `Recording parser fixtures → ${path.basename(PARSER_FIXTURES_DIR.pathname)}/`,
    );
    await recordParserFixtures(celexOnly);
  }

  if (noticeOnly || !only) {
    log(
      `Recording notice fixtures → ${path.basename(ADAPTER_FIXTURES_DIR.pathname)}/`,
    );
    await recordNoticeFixtures();
  }

  if (seedOnly || !only) {
    log("Recording seed fixture → __fixtures__/case-law/eu-ecj.json.gz");
    await recordSeedFixture();
  }
  log("done");
}
