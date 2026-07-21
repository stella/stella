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
 *    checked against the publisher rather than against itself.
 * 2. The seed fixture (`scripts/__fixtures__/case-law/eu-ecj.json`) in
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
 */

import JSZip from "jszip";
import path from "node:path";

import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { fetchDecisionsByCelex } from "@/api/handlers/case-law/ingestion/adapters/eu-ecj";
import { INGESTION_USER_AGENT } from "@/api/handlers/case-law/ingestion/adapters/utils";

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
    languages: ["EL"],
    why: "Judgment in a non-Latin script, with guillemets rather than parentheses around the keyword chain. Shorter than Schrems II, which is the point: script coverage does not need document length.",
  },
  {
    celex: "62018CC0311",
    languages: ["FI"],
    why: "Advocate General opinion: no heading classes at all, a six-level outline that switches from bold to italic with depth, and 220 footnotes. Finnish numbers its sections without a trailing period, so the depth cannot be read off punctuation.",
  },
  {
    celex: "62023CO0786",
    languages: ["EN"],
    why: "Order: the short form of the judgment layout, and the smallest complete document in the corpus.",
  },
  {
    celex: "62023TJ0201",
    languages: ["EN"],
    why: "General Court judgment: a different signature block (per-judge cells rather than one [Signatures] line).",
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

const PARSER_FIXTURES_DIR = new URL(
  "../src/handlers/case-law/ingestion/parsers/__fixtures__/eu-ecj/",
  import.meta.url,
);
const SEED_FIXTURE = new URL(
  "__fixtures__/case-law/eu-ecj.json",
  import.meta.url,
);

const SPARQL_URL = "https://publications.europa.eu/webapi/rdf/sparql";
const FETCH_TIMEOUT_MS = 120_000;

const log = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

// ── Formex, for the oracle ─────────────────────────────────

/**
 * Resolve a decision's Formex manifestation and download it. Cellar
 * serves it either directly or wrapped in a zip, depending on how the
 * document was published, and negotiates on an exact media type.
 */
const fetchFormex = async (
  celex: string,
  languageUri: string,
): Promise<Uint8Array | undefined> => {
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
    return new Uint8Array(await typed.arrayBuffer());
  }

  const zipped = await fetch(contentUrl, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Accept: "application/zip", "User-Agent": INGESTION_USER_AGENT },
  });
  if (!zipped.ok) {
    return undefined;
  }
  return await unzipSingleEntry(new Uint8Array(await zipped.arrayBuffer()));
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
  const zip = await JSZip.loadAsync(archive);
  const entry = Object.values(zip.files).find((file) => !file.dir);
  return await entry?.async("uint8array");
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

const recordParserFixtures = async (): Promise<void> => {
  for (const { celex, languages } of PARSER_CORPUS) {
    // oxlint-disable-next-line no-await-in-loop -- sequential by design: Cellar is rate-limited and this is a recorder, not a hot path
    const decisions = await fetchDecisionsByCelex({
      celexNumbers: [celex],
      languages,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS * languages.length),
    });

    for (const decision of decisions) {
      const stem = `${celex}.${decision.language}`;
      if (decision.sourceRaw === undefined) {
        log(`  ${stem}: no XHTML, skipped`);
        continue;
      }

      // oxlint-disable-next-line no-await-in-loop -- one write per recorded variant
      await Bun.write(
        new URL(`${stem}.html.gz`, PARSER_FIXTURES_DIR),
        Bun.gzipSync(Buffer.from(decision.sourceRaw)),
      );

      // oxlint-disable-next-line no-await-in-loop -- sequential Cellar lookup per variant
      const formex = await fetchFormex(celex, languageUriOf(decision));
      if (formex === undefined) {
        log(`  ${stem}: XHTML only (no Formex published)`);
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- one write per recorded variant
      await Bun.write(
        new URL(`${stem}.fmx.xml.gz`, PARSER_FIXTURES_DIR),
        Bun.gzipSync(formex),
      );
      log(`  ${stem}: XHTML + Formex`);
    }
  }
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
    // oxlint-disable-next-line no-await-in-loop -- sequential by design: Cellar is rate-limited
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
    `${JSON.stringify(
      {
        source: {
          id: sourceId,
          name: "Court of Justice of the EU (CJEU)",
          config: {},
          enabled: true,
          adapter_key: "eu-ecj",
        },
        decisions: rows,
      },
      null,
      1,
    )}\n`,
  );
};

if (import.meta.main) {
  const parserOnly = process.argv.includes("--parser-only");

  log(
    `Recording parser fixtures → ${path.basename(PARSER_FIXTURES_DIR.pathname)}/`,
  );
  await recordParserFixtures();

  if (!parserOnly) {
    log("Recording seed fixture → __fixtures__/case-law/eu-ecj.json");
    await recordSeedFixture();
  }
  log("done");
}
