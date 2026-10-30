import { Glob } from "bun";

import type { Block, DocumentAst } from "@stll/legal-ast/document-ast";

import type { ValidationSource } from "@/api/lib/legal-search/parsers/validate-ast";

const ROOT = new URL("../../handlers/case-law/ingestion/", import.meta.url);
const PARSER_FIXTURES = new URL("parsers/__fixtures__/", ROOT);
const ADAPTER_FIXTURES = new URL("adapters/__fixtures__/", ROOT);

export type ValidateAstFixture = {
  name: string;
  bytes: Uint8Array;
  markup: string;
  validationMarkup?: string;
  xml: boolean;
  parse: () => DocumentAst;
};

export type ValidateAstInput = {
  name: string;
  source: ValidationSource;
  blocks: Block[];
};

const gunzipText = (bytes: Uint8Array): string =>
  new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(bytes)));

const readMarkup = async (url: URL) => {
  const bytes = await Bun.file(url).bytes();
  return {
    bytes,
    text: url.pathname.endsWith(".gz")
      ? gunzipText(bytes)
      : new TextDecoder().decode(bytes),
  };
};

const fixtureNames = async (directory: URL, pattern: string) =>
  Array.fromAsync(new Glob(pattern).scan(directory.pathname)).then((names) =>
    names.toSorted(),
  );

export const buildValidateAstFixtures = async (): Promise<
  ValidateAstFixture[]
> => {
  const { parseNssDecisionHtml } =
    await import("@/api/handlers/case-law/ingestion/parsers/cz-nss");
  const { parseEcjDecisionHtml } =
    await import("@/api/handlers/case-law/ingestion/parsers/eu-ecj");
  const { parseUsDecisionHtml } =
    await import("@/api/handlers/case-law/ingestion/parsers/cz-us");
  const { parsePlTkPage, parsePlTkText, readPlTkCasePage, readPlTkRuling } =
    await import("@/api/handlers/case-law/ingestion/parsers/pl-tk");
  const { parsePlUodoDecisionXml } =
    await import("@/api/handlers/case-law/ingestion/parsers/pl-uodo");
  const fixtures: ValidateAstFixture[] = [];

  for (const name of await fixtureNames(PARSER_FIXTURES, "cz-nss-*.html.gz")) {
    const { bytes, text } = await readMarkup(new URL(name, PARSER_FIXTURES));
    fixtures.push({
      name: `parsers/${name}`,
      bytes,
      markup: text,
      xml: false,
      parse: () =>
        parseNssDecisionHtml({
          caseNumber: name,
          ecli: undefined,
          court: "Nejvyšší správní soud",
          decisionDate: undefined,
          decisionType: undefined,
          sourceUrl: undefined,
          html: text,
          detailMetadata: {},
        }).documentAst,
    });
  }
  for (const name of await fixtureNames(PARSER_FIXTURES, "cz-us-*.html.gz")) {
    const { bytes, text } = await readMarkup(new URL(name, PARSER_FIXTURES));
    fixtures.push({
      name: `parsers/${name}`,
      bytes,
      markup: text,
      xml: false,
      parse: () =>
        parseUsDecisionHtml({
          html: text,
          caseNumber: name,
          ecli: undefined,
          court: "Ústavní soud",
          decisionDate: undefined,
          decisionType: undefined,
        }).documentAst,
    });
  }
  const ecjSources = [
    ...(await fixtureNames(PARSER_FIXTURES, "eu-ecj/*.html.gz")),
    ...(await fixtureNames(ADAPTER_FIXTURES, "eu-ecj-*.page.html.gz")),
    ...(await fixtureNames(ADAPTER_FIXTURES, "eu-ecj-fulltext-*.html")),
  ].filter((name) => !name.includes("portal-shell"));
  for (const name of ecjSources) {
    const directory = name.startsWith("eu-ecj/")
      ? PARSER_FIXTURES
      : ADAPTER_FIXTURES;
    const { bytes, text } = await readMarkup(new URL(name, directory));
    const stem = name.split("/").at(-1) ?? name;
    const [celex = stem, language = "und"] = stem.split(".");
    fixtures.push({
      name: `${directory === PARSER_FIXTURES ? "parsers" : "adapters"}/${name}`,
      bytes,
      markup: text,
      xml: false,
      parse: () =>
        parseEcjDecisionHtml({
          html: text,
          celex,
          caseNumber: celex,
          ecli: undefined,
          court: "Court of Justice of the European Union",
          decisionDate: undefined,
          decisionType: undefined,
          language,
          sourceUrl: undefined,
        }).documentAst,
    });
  }
  for (const name of await fixtureNames(PARSER_FIXTURES, "pl-uodo-*.xml")) {
    const { bytes, text } = await readMarkup(new URL(name, PARSER_FIXTURES));
    fixtures.push({
      name: `parsers/${name}`,
      bytes,
      markup: text,
      xml: true,
      parse: () => {
        const parsed = parsePlUodoDecisionXml({
          xml: text,
          documentId: name,
          caseNumber: name,
          court: "Prezes Urzędu Ochrony Danych Osobowych",
          decisionDate: undefined,
          decisionType: "decyzja",
          sourceUrl: undefined,
        });
        if (parsed.isErr()) {
          throw parsed.error;
        }
        return parsed.value.documentAst;
      },
    });
  }
  for (const name of await fixtureNames(
    PARSER_FIXTURES,
    "pl-tk-case-*.html.gz",
  )) {
    const { bytes, text } = await readMarkup(new URL(name, PARSER_FIXTURES));
    const page = parsePlTkPage(text);
    const pageRecord = readPlTkCasePage(page);
    const ruling = pageRecord?.rulingIds
      .map((documentId) => readPlTkRuling(page, documentId))
      .find((candidate) => candidate?.textHtml !== undefined);
    if (pageRecord === null || ruling?.textHtml === undefined) {
      continue;
    }
    const { documentId, textHtml } = ruling;
    fixtures.push({
      name: `parsers/${name}`,
      bytes,
      markup: text,
      validationMarkup: `<body>${textHtml}</body>`,
      xml: false,
      parse: () => {
        const parsedPage = parsePlTkPage(text);
        readPlTkRuling(parsedPage, documentId);
        return parsePlTkText({
          page: parsedPage,
          caseNumber: pageRecord.record.caseNumber ?? documentId,
          court: ruling.courtAsPrinted ?? "Trybunał Konstytucyjny",
          decisionDate: ruling.decisionDate,
          decisionType: ruling.decisionForm,
          documentId,
          sourceUrl: "https://ipo.trybunal.gov.pl/ipo/Sprawa",
          documentUrl: undefined,
          textHtml,
        }).documentAst;
      },
    });
  }
  return fixtures;
};

const seededIndex = (name: string, length: number): number => {
  let seed = 2_166_136_261;
  for (const character of name) {
    seed = (seed * 33 + (character.codePointAt(0) ?? 0)) % 2_147_483_647;
  }
  return Math.abs(seed) % length;
};

const cloneBlocks = (blocks: Block[]): Block[] => structuredClone(blocks);

export const buildValidateAstInputs = async (): Promise<ValidateAstInput[]> => {
  const inputs: ValidateAstInput[] = [];
  for (const fixture of await buildValidateAstFixtures()) {
    const source = fixture.validationMarkup ?? fixture.markup;
    const blocks = fixture.parse().blocks;
    inputs.push({ name: `${fixture.name}#current`, source, blocks });
    const paragraphs = blocks
      .map((block, index) => ({ block, index }))
      .filter(({ block }) => block.type === "paragraph");
    if (paragraphs.length > 0) {
      const selected = paragraphs.at(
        seededIndex(`${fixture.name}:drop`, paragraphs.length),
      );
      if (selected === undefined) {
        continue;
      }
      const dropped = cloneBlocks(blocks);
      dropped.splice(selected.index, 1);
      inputs.push({
        name: `${fixture.name}#dropped-paragraph`,
        source,
        blocks: dropped,
      });
      const duplicate = cloneBlocks(blocks);
      duplicate.splice(
        selected.index,
        0,
        ...duplicate.slice(selected.index, selected.index + 1),
      );
      inputs.push({
        name: `${fixture.name}#duplicated-paragraph`,
        source,
        blocks: duplicate,
      });
      const merged = cloneBlocks(blocks);
      const target = merged.at(selected.index);
      if (target !== undefined) {
        target.plainText = target.plainText.replace(/\s+/u, "");
      }
      inputs.push({
        name: `${fixture.name}#merged-words`,
        source,
        blocks: merged,
      });
    }
    if (blocks.length > 1) {
      const reordered = cloneBlocks(blocks);
      const index = seededIndex(`${fixture.name}:reorder`, blocks.length - 1);
      reordered.splice(
        index,
        2,
        ...reordered.slice(index, index + 2).toReversed(),
      );
      inputs.push({
        name: `${fixture.name}#reordered-blocks`,
        source,
        blocks: reordered,
      });
    }
    const footnotes = blocks
      .map((block, index) => ({ block, index }))
      .filter(
        ({ block }) =>
          (block.type === "paragraph" || block.type === "table") &&
          block.note?.type === "footnote",
      );
    if (footnotes.length > 0) {
      const selected = footnotes.at(
        seededIndex(`${fixture.name}:footnote`, footnotes.length),
      );
      if (selected === undefined) {
        continue;
      }
      const removed = cloneBlocks(blocks);
      removed.splice(selected.index, 1);
      inputs.push({
        name: `${fixture.name}#removed-footnote`,
        source,
        blocks: removed,
      });
    }
  }
  return inputs;
};
