/**
 * The insolvency register as tests serve it.
 *
 * The register's PDFs are not kept as fixtures, since they are not
 * anonymised: a document is set here as a PDF from the anonymised paragraphs
 * of a recorded decision (`parsers/__fixtures__/cz-isir-*.json`), typeset the
 * way a court's PDF is (first lines indented, headings in bold, the
 * register's signature stamp at each page's foot). The feed page is composed
 * from recorded actions (`adapters/__fixtures__/cz-isir-feed-page.xml`).
 */
import { PDF } from "@libpdf/core";
import { panic, Result } from "better-result";
import * as v from "valibot";

import {
  czIsirFetchPage,
  encodeCzIsirCursor,
} from "@/api/handlers/case-law/ingestion/adapters/cz-isir";
import type { CzIsirAnonymizer } from "@/api/handlers/case-law/ingestion/adapters/cz-isir-anonymization";
import { CZ_ISIR_FEED_URL } from "@/api/handlers/case-law/ingestion/adapters/cz-isir-feed";
import type { CzIsirParagraph } from "@/api/handlers/case-law/ingestion/parsers/cz-isir";
import { planUnreadItems } from "@/api/handlers/case-law/ingestion/pipeline/unread-items";
import { UNAVAILABLE_CYCLES_BEFORE_MARKING } from "@/api/lib/errors/read-outcome";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";
import { withTestFetch } from "@/api/tests/helpers/test-fetch";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const FEED = new URL(
  "../../handlers/case-law/ingestion/adapters/__fixtures__/cz-isir-feed-page.xml",
  import.meta.url,
);
const PARSER_FIXTURES = new URL(
  "../../handlers/case-law/ingestion/parsers/__fixtures__/",
  import.meta.url,
);
const FONTS = new URL("../../lib/files/pdf-signing/fonts/", import.meta.url);

/** The recorded decisions, by fixture name, and the document ids the feed page gives them. */
const CZ_ISIR_DECISION_FIXTURES = {
  "65350048": "cz-isir-3-vsph-1361-2023",
  "81161847": "cz-isir-103-vsph-257-2026",
} as const;

export type CzIsirDocumentId = keyof typeof CZ_ISIR_DECISION_FIXTURES;

/** The feed page's cursor position before its first action. */
export const CZ_ISIR_FIXTURE_CURSOR = encodeCzIsirCursor({
  version: 1,
  after: 65_000_400,
});

const paragraphsSchema = v.array(
  v.strictObject({ text: v.string(), bold: v.boolean() }),
);

export const czIsirDecisionParagraphs = async (
  documentId: CzIsirDocumentId,
): Promise<CzIsirParagraph[]> =>
  v.parse(
    paragraphsSchema,
    await Bun.file(
      new URL(`${CZ_ISIR_DECISION_FIXTURES[documentId]}.json`, PARSER_FIXTURES),
    ).json(),
  );

/** Words into lines of at most `width` characters. */
const wrap = (text: string, width: number): string[] => {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line.length > 0 && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line.length === 0 ? word : `${line} ${word}`;
    }
  }
  return line.length === 0 ? lines : [...lines, line];
};

const STAMP = [
  "cn=ISIR, c=CZ,",
  "ou=Insolvenční",
  "rejstřík,",
  "serialNumber=",
  "S131469",
] as const;

const fontBytes = async (name: string) =>
  new Uint8Array(await Bun.file(new URL(name, FONTS)).arrayBuffer());

/** The paragraphs set as a court's PDF sets them. */
export const typesetCzIsirDocument = async (
  paragraphs: readonly CzIsirParagraph[],
): Promise<Uint8Array> => {
  const pdf = PDF.create();
  const regular = pdf.embedFont(await fontBytes("DejaVuSans.ttf"));
  const bold = pdf.embedFont(await fontBytes("DejaVuSans-Bold.ttf"));
  let page = pdf.addPage({ size: "a4" });
  let y = 790;
  const stamp = () => {
    for (const [index, line] of STAMP.entries()) {
      page.drawText(line, {
        x: 480,
        y: 120 - index * 9,
        size: 6,
        font: regular,
      });
    }
  };
  for (const { text, bold: isBold } of paragraphs) {
    for (const [index, line] of wrap(text, 80).entries()) {
      if (y < 160) {
        stamp();
        page = pdf.addPage({ size: "a4" });
        y = 790;
      }
      page.drawText(line, {
        x: index === 0 ? 92 : 56,
        y,
        size: 10,
        font: isBold ? bold : regular,
      });
      y -= 14;
    }
    y -= 10;
  }
  stamp();
  return await pdf.save();
};

/** Each recorded decision typeset, by document id. */
export const czIsirFixtureDocuments = async (): Promise<
  Record<CzIsirDocumentId, Uint8Array>
> => ({
  "65350048": await typesetCzIsirDocument(
    await czIsirDecisionParagraphs("65350048"),
  ),
  "81161847": await typesetCzIsirDocument(
    await czIsirDecisionParagraphs("81161847"),
  ),
});

/** Documents by id; null answers 404, an absent id 404 too, a number that status. */
export type CzIsirServedDocuments = Readonly<
  Record<string, Uint8Array | number | null>
>;

/** The register's transport: the feed page (the recorded one unless given) for every feed call, each document by id. */
export const czIsirTransport = async (
  documents: CzIsirServedDocuments,
  requested: string[] = [],
  feedXml?: string,
): Promise<typeof fetch> => {
  const feed = feedXml ?? (await Bun.file(FEED).text());
  return asFetchMock(async (input, init) => {
    let url: string;
    if (typeof input === "string") {
      url = input;
    } else if (input instanceof URL) {
      url = input.href;
    } else {
      url = input.url;
    }
    requested.push(`${init?.method ?? "GET"} ${url}`);
    if (url === CZ_ISIR_FEED_URL) {
      return await Promise.resolve(
        new Response(feed, {
          headers: { "Content-Type": "text/xml; charset=utf-8" },
        }),
      );
    }
    const id = new URL(url).searchParams.get("idDokument") ?? "";
    const document = documents[id];
    if (typeof document === "number") {
      return await Promise.resolve(new Response("", { status: document }));
    }
    return await Promise.resolve(
      document === undefined || document === null
        ? new Response("", { status: 404 })
        : new Response(document, {
            headers: { "Content-Type": `application/pdf; name="${id}.pdf"` },
          }),
    );
  });
};

/**
 * Passes text through unchanged: the fixtures' text is anonymised already,
 * and anonymisation has a suite of its own.
 */
export const CZ_ISIR_PASS_THROUGH: CzIsirAnonymizer = {
  anonymize: (paragraphs) => Result.ok([...paragraphs]),
};

/** The decision the feed page's first high-court action builds. */
export const buildCzIsirFixtureDecision = async (): Promise<IngestionResult> =>
  await withTestFetch(
    await czIsirTransport(await czIsirFixtureDocuments()),
    async () => {
      const page = await czIsirFetchPage(
        CZ_ISIR_FIXTURE_CURSOR,
        {},
        undefined,
        CZ_ISIR_PASS_THROUGH,
      );
      if (Result.isError(page)) {
        return await Promise.reject(page.error);
      }
      const decision = page.value.decisions.find(
        ({ sourceDocumentId }) => sourceDocumentId === "65350048",
      );
      if (decision !== undefined) {
        return decision;
      }
      // What the pipeline stores for an unread document once its bound is
      // spent: the listing-only row with the typed outcome.
      const item =
        page.value.unreadItems?.find(
          ({ listing }) => listing.sourceDocumentId === "65350048",
        ) ?? panic("the cz-isir fixture built no decision");
      return (
        planUnreadItems([item], {
          [item.listing.sourceDocumentId]:
            UNAVAILABLE_CYCLES_BEFORE_MARKING - 1,
        }).terminal.at(0) ?? panic("the cz-isir unread item stored nothing")
      );
    },
  );
