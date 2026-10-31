/**
 * Replay of the builders over captured soft-law publications.
 *
 * Each capture is the publisher's bytes as served (gzipped beside a sidecar
 * naming their uncompressed hash), so the replay reads what production reads.
 * A PDF is replayed through its text layer, extracted as the soft-law
 * extractor stores it: one entry per page, joined by `PDF_PAGE_SEPARATOR`.
 *
 * The snapshot is the reviewable contract: the outline a reader navigates,
 * the footnotes left without a placed reference, the acts cited, and a digest
 * of the whole AST so no change to it passes unseen. Regenerate it with
 * `bun test --update-snapshots` after an intended builder change.
 */

import { PDF } from "@libpdf/core";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import * as v from "valibot";

import {
  documentAstSchema,
  omitDerivablePlainText,
  parseDocumentAst,
  plainTextOf,
} from "@stll/legal-ast/document-ast";
import type {
  DocumentAst,
  GuidanceMetadata,
  Inline,
} from "@stll/legal-ast/document-ast";
import { sha256Hex } from "@stll/sha256/node";

import { guidanceMetadataOf } from "./guidance-metadata";
import { buildHtmlDocumentAst } from "./html-document-ast";
import {
  buildPdfTextDocumentAst,
  PDF_PAGE_SEPARATOR,
} from "./pdf-text-document-ast";

const SOFT_LAW_DIR = path.resolve(
  import.meta.dir,
  "../../../handlers/soft-law",
);

const EDPB = {
  type: "authority",
  name: "European Data Protection Board",
  jurisdiction: "EU",
} as const;

const EDPB_GUIDELINES_3_2025 = {
  type: "guidance",
  kind: "guideline",
  title: "Guidelines 3/2025 on the interplay between the DSA and the GDPR",
  reference: "Guidelines 3/2025",
  issuedOn: "2026-09-17",
  issuer: EDPB,
} satisfies GuidanceMetadata;

type Replay = {
  name: string;
  fixture: string;
  metadata: GuidanceMetadata;
} & ({ format: "pdf" } | { format: "html"; contentRoot: string });

const REPLAYS = [
  {
    name: "EDPB Guidelines 3/2025 (PDF)",
    fixture: "__fixtures__/edpb-final.pdf.gz",
    format: "pdf",
    metadata: EDPB_GUIDELINES_3_2025,
  },
  {
    name: "EDPB Guidelines 3/2025 (record page)",
    fixture: "__fixtures__/edpb-final.html.gz",
    format: "html",
    contentRoot: ".document-full__content",
    metadata: EDPB_GUIDELINES_3_2025,
  },
  {
    name: "WP29 transparency guidelines (record page)",
    fixture: "adapters/__fixtures__/wp29-transparency.html.gz",
    format: "html",
    contentRoot: ".cnect-main-body",
    metadata: {
      type: "guidance",
      kind: "guideline",
      title: "Guidelines on Transparency under Regulation 2016/679",
      reference: "wp260rev.01",
      // The page prints the date day first: `22/08/2018`.
      issuedOn: "2018-08-22",
      issuer: {
        type: "authority",
        name: "Article 29 Working Party",
        jurisdiction: "EU",
      },
    },
  },
  {
    name: "ÚOOÚ methodologies and recommendations (listing page)",
    fixture: "__fixtures__/uoou-listing.html.gz",
    format: "html",
    contentRoot: "#mainblock",
    metadata: guidanceMetadataOf({
      authority: "cz-uoou",
      metadata: {
        title: "Metodiky a doporučení pro správce",
        kind: "methodology",
        statedReference: { state: "not_stated" },
        issuedOn: { state: "not_stated" },
        validity: { state: "not_stated", basis: "source_stated" },
      },
    }),
  },
] as const satisfies readonly Replay[];

const provenanceSchema = v.object({
  sha256: v.string(),
  sourceUrl: v.string(),
});

const readCapture = async (fixture: string) => {
  const file = path.join(SOFT_LAW_DIR, fixture);
  const bytes = gunzipSync(await Bun.file(file).bytes());
  const provenance = v.parse(
    provenanceSchema,
    await Bun.file(`${file}.provenance.json`).json(),
  );
  return { bytes, provenance };
};

const pdfTextLayer = async (bytes: Uint8Array): Promise<string> =>
  (await PDF.load(bytes))
    .extractText()
    .map((page) => page.text)
    .join(PDF_PAGE_SEPARATOR)
    .trim();

const buildReplay = async (replay: Replay): Promise<DocumentAst> => {
  const { bytes, provenance } = await readCapture(replay.fixture);
  const source = {
    system: new URL(provenance.sourceUrl).hostname,
    documentId: path.basename(replay.fixture, ".gz"),
    webUrl: provenance.sourceUrl,
    printUrl: "",
  };
  switch (replay.format) {
    case "pdf": {
      return buildPdfTextDocumentAst({
        text: await pdfTextLayer(bytes),
        source,
        metadata: replay.metadata,
      }).unwrap();
    }
    case "html": {
      return buildHtmlDocumentAst({
        html: new TextDecoder().decode(bytes),
        contentRoot: replay.contentRoot,
        baseUrl: provenance.sourceUrl,
        source,
        metadata: replay.metadata,
      }).unwrap();
    }
    default: {
      replay satisfies never;
      return panic(`Unhandled replay: ${String(replay)}`);
    }
  }
};

const walk = (inlines: readonly Inline[], visit: (inline: Inline) => void) => {
  for (const inline of inlines) {
    visit(inline);
    if (
      inline.type !== "text" &&
      inline.type !== "line-break" &&
      inline.type !== "page-anchor"
    ) {
      walk(inline.children, visit);
    }
  }
};

const inlineRuns = (ast: DocumentAst): Inline[][] =>
  ast.blocks.flatMap((block) => {
    switch (block.type) {
      case "heading":
      case "paragraph":
        return [block.inlines];
      case "table":
        return block.rows.flatMap((row) => row.map(({ inlines }) => inlines));
      case "image":
        return [];
      default:
        block satisfies never;
        return [];
    }
  });

/** What a reviewer reads in the snapshot when the builders change. */
const summaryOf = (ast: DocumentAst) => {
  const referenced = new Set<string>();
  const acts = new Map<string, number>();
  for (const block of ast.blocks) {
    const inlines =
      block.type === "paragraph" || block.type === "heading"
        ? block.inlines
        : [];
    if (block.type === "paragraph" && block.note !== undefined) {
      continue;
    }
    walk(inlines, (inline) => {
      if (inline.type === "superscript") {
        referenced.add(plainTextOf(inline.children));
      }
    });
  }
  for (const run of inlineRuns(ast)) {
    walk(run, (inline) => {
      if (
        inline.type === "citation" &&
        inline.target?.status === "legislation"
      ) {
        const { appliedVersion, number, series, year } = inline.target;
        const key = `${series} ${year}/${number}${appliedVersion === undefined ? "" : ` @ ${appliedVersion.date}`}`;
        acts.set(key, (acts.get(key) ?? 0) + 1);
      }
    });
  }
  const numbers = ast.blocks.flatMap((block) =>
    block.type === "paragraph" && block.number !== undefined
      ? [block.number]
      : [],
  );
  const notes = ast.blocks.flatMap((block) =>
    block.type === "paragraph" && block.note !== undefined
      ? [block.note.label]
      : [],
  );
  return {
    blocks: ast.blocks.length,
    outline: ast.blocks.flatMap((block) =>
      block.type === "heading" ? [`${block.id} ${block.plainText}`] : [],
    ),
    numberedParagraphs: numbers.length,
    footnotes: notes.length,
    footnotesWithoutReference: notes.filter((label) => !referenced.has(label)),
    // Keys are act identifiers, not words: code-unit order is the stable one.
    legislation: Object.fromEntries(
      [...acts.keys()].toSorted().map((key) => [key, acts.get(key)]),
    ),
    digest: sha256Hex(JSON.stringify(ast)),
  };
};

describe.each(REPLAYS)("replaying $name", (replay) => {
  test("reads the capture byte for byte", async () => {
    const { bytes, provenance } = await readCapture(replay.fixture);
    expect(sha256Hex(bytes)).toBe(provenance.sha256);
  });

  test("builds a valid document that round-trips and replays identically", async () => {
    const ast = await buildReplay(replay);
    expect(v.is(documentAstSchema, ast)).toBe(true);
    expect(parseDocumentAst(omitDerivablePlainText(ast))).toEqual(ast);
    expect(await buildReplay(replay)).toEqual(ast);
    const ids = ast.blocks.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("numbers paragraphs strictly upward from 1 without gaps", async () => {
    const ast = await buildReplay(replay);
    const numbers = ast.blocks.flatMap((block) =>
      block.type === "paragraph" && block.number !== undefined
        ? [block.number]
        : [],
    );
    expect(numbers).toEqual(numbers.map((_, index) => index + 1));
  });

  test("matches the reviewed outline", async () => {
    expect(summaryOf(await buildReplay(replay))).toMatchSnapshot();
  });
});

test("unseparated captured PDF notes retain their labels and text", async () => {
  const replay = REPLAYS.find(({ format }) => format === "pdf");
  if (replay === undefined) {
    panic("The captured PDF replay is missing");
  }
  const ast = await buildReplay(replay);
  const note = ast.blocks.find(({ id }) => id === "fn-97");
  expect(note?.plainText).toContain("98 Article 9(1) GDPR:");
  expect(note?.plainText).toContain("102 Article 22(4) GDPR.");
  expect(ast.blocks.some(({ id }) => id === "fn-98")).toBe(false);
});
