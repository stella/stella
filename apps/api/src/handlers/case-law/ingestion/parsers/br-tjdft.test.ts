import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import type { Block } from "@stll/legal-ast/document-ast";

import { parseBrTjdftDocument } from "@/api/handlers/case-law/ingestion/parsers/br-tjdft";
import type { BrTjdftDocumentContent } from "@/api/handlers/case-law/ingestion/parsers/br-tjdft";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import { brTjdftCompletenessIssues } from "@/api/tests/helpers/br-tjdft-completeness";

const recordOf = async (name: string): Promise<Record<string, unknown>> => {
  const bytes = new Uint8Array(
    await Bun.file(
      new URL(`../adapters/__fixtures__/${name}`, import.meta.url),
    ).arrayBuffer(),
  );
  const answer: unknown = JSON.parse(
    new TextDecoder().decode(Bun.gunzipSync(bytes)),
  );
  const rows =
    isRecord(answer) && isUnknownArray(answer["registros"])
      ? answer["registros"].filter(isRecord)
      : [];
  return rows.at(0) ?? panic(`${name} holds no record`);
};

const htmlOf = async (name: string): Promise<string> => {
  const html = (await recordOf(name))["inteiroTeorHtml"];
  return typeof html === "string" ? html : panic(`${name} has no HTML`);
};

const parse = (content: BrTjdftDocumentContent) =>
  parseBrTjdftDocument({
    content,
    documentId: "fixture",
    caseNumber: "fixture",
    court: "Tribunal de Justiça do Distrito Federal e dos Territórios",
    decisionDate: undefined,
    decisionType: undefined,
    sourceUrl: "https://jurisdf.tjdft.jus.br/acordaos/fixture",
  });

const headings = (blocks: readonly Block[]) =>
  blocks.flatMap((block) =>
    block.type === "heading" ? [block.plainText] : [],
  );

const RECORDED_HTML = [
  "br-tjdft-detail-acordao-pje.json.gz",
  "br-tjdft-detail-acordao-designado.json.gz",
  "br-tjdft-detail-acordao-revisor.json.gz",
  "br-tjdft-detail-acordao-2010.json.gz",
  "br-tjdft-listing-acordao-1999.json.gz",
  "br-tjdft-detail-decisao.json.gz",
] as const;

describe("every recorded full text", () => {
  for (const name of RECORDED_HTML) {
    test(`${name}: keeps all of its words and none of its markup`, async () => {
      const html = await htmlOf(name);
      const { documentAst } = parse({ type: "html", text: html });
      expect(brTjdftCompletenessIssues(html, documentAst.blocks)).toEqual([]);
      // The letterhead logo is an inline data URI; no image block may carry it.
      expect(documentAst.blocks.some((block) => block.type === "image")).toBe(
        false,
      );
      expect(JSON.stringify(documentAst.blocks)).not.toContain("data:image");
    });
  }
});

describe("an electronic-process acórdão", () => {
  test("its titles are the paragraphs the court set in bold capitals", async () => {
    const { documentAst } = parse({
      type: "html",
      text: await htmlOf("br-tjdft-detail-acordao-pje.json.gz"),
    });
    expect(headings(documentAst.blocks)).toEqual([
      "EMENTA",
      "ACÓRDÃO",
      "RELATÓRIO",
      "VOTOS",
      "DECISÃO",
    ]);
  });

  test("the case data is a table and the votes are paragraphs, not one cell", async () => {
    const { documentAst } = parse({
      type: "html",
      text: await htmlOf("br-tjdft-detail-acordao-pje.json.gz"),
    });
    const tables = documentAst.blocks.filter((block) => block.type === "table");
    expect(tables).toHaveLength(1);
    const [data] = tables;
    expect(data?.type === "table" ? data.role : undefined).toBe(
      "metadata-table",
    );
    expect(data?.type === "table" ? data.rows.slice(0, 2) : []).toEqual([
      [
        expect.objectContaining({ plainText: "Órgão" }),
        expect.objectContaining({ plainText: "1ª Turma Criminal" }),
      ],
      [
        expect.objectContaining({ plainText: "Processo N." }),
        expect.objectContaining({
          plainText: "AGRAVO DE EXECUÇÃO PENAL 0753268-53.2023.8.07.0000",
        }),
      ],
    ]);
    expect(
      documentAst.blocks.some(
        (block) =>
          block.type === "paragraph" &&
          block.plainText ===
            "Conheço do recurso, porquanto estão presentes os pressupostos de admissibilidade.",
      ),
    ).toBe(true);
  });

  test("the letterhead beside the logo is read as text", async () => {
    const { documentAst } = parse({
      type: "html",
      text: await htmlOf("br-tjdft-detail-acordao-pje.json.gz"),
    });
    expect(documentAst.blocks.at(0)?.plainText).toBe(
      "Poder Judiciário da União\nTRIBUNAL DE JUSTIÇA DO DISTRITO FEDERAL E DOS TERRITÓRIOS",
    );
  });
});

describe("a text rendering", () => {
  test("joins hard-wrapped lines and reads centred capitals as titles", async () => {
    const { documentAst } = parse({
      type: "html",
      text: await htmlOf("br-tjdft-detail-acordao-2010.json.gz"),
    });
    expect(headings(documentAst.blocks)).toEqual([
      "E M E N T A",
      "A C Ó R D Ã O",
      "R E L A T Ó R I O",
      "V O T O S",
      "D E C I S Ã O",
    ]);
    const ementa = documentAst.blocks.find((block) =>
      block.plainText.startsWith("AÇÃO RESCISÓRIA – DEPÓSITO PRÉVIO"),
    );
    // Three lines in the rendering, one paragraph in the decision.
    expect(ementa?.plainText).toContain(
      "Indefere-se a petição inicial da Ação Rescisória quando não efetuado o depósito prévio",
    );
    expect(ementa?.plainText).not.toContain("\n");
  });

  test("a bordered box is prose, a bordered grid is a table, a boxed title is a title", async () => {
    const { documentAst } = parse({
      type: "html",
      text: await htmlOf("br-tjdft-listing-acordao-1999.json.gz"),
    });
    const [data] = documentAst.blocks;
    expect(data?.type === "table" ? data.rows.at(0) : undefined).toEqual([
      expect.objectContaining({ plainText: "Órgão" }),
      expect.objectContaining({ plainText: ":" }),
      expect.objectContaining({ plainText: "Conselho Especial" }),
    ]);
    expect(headings(documentAst.blocks)).toEqual(
      expect.arrayContaining(["ACÓRDÃO", "RELATÓRIO", "VOTOS", "DECISÃO"]),
    );
    expect(
      documentAst.blocks.find((block) =>
        block.plainText.startsWith("PROCESSO CIVIL. MANDADO DE SEGURANÇA"),
      )?.plainText,
    ).not.toContain("|");
    // The operative decision is capitals in a box of its own, and stays text.
    expect(headings(documentAst.blocks)).not.toContain(
      "“CONCEDEU-SE A ORDEM. MAIORIA.”",
    );
  });
});

describe("a judgment the court publishes no full text for", () => {
  test("is its headnote and its operative decision, in that order", () => {
    const { documentAst, fulltext } = parse({
      type: "record",
      ementa: "NULA É A CITAÇÃO EDITALÍCIA.",
      decisao: "PROVER O RECURSO. DECISÃO UNÂNIME.",
    });
    expect(documentAst.blocks.map((block) => block.type)).toEqual([
      "paragraph",
      "paragraph",
    ]);
    const [, holding] = documentAst.blocks;
    expect(holding?.type === "paragraph" ? holding.role : undefined).toBe(
      "holding",
    );
    expect(fulltext).toBe(
      "NULA É A CITAÇÃO EDITALÍCIA.\n\nPROVER O RECURSO. DECISÃO UNÂNIME.",
    );
  });
});

describe("markup the parser does not classify", () => {
  test("still reaches the document in order (rule 10)", () => {
    const { fulltext } = parse({
      type: "html",
      text: "<p>Antes</p><marquee>Dentro de um elemento desconhecido</marquee><div><span>Depois <em>em itálico</em></span></div>",
    });
    expect(fulltext).toBe(
      "Antes\n\nDentro de um elemento desconhecido\n\nDepois em itálico",
    );
  });

  test("a bold capitals paragraph long enough to be a headnote stays a paragraph", () => {
    const text = `AGRAVO EM EXECUÇÃO PENAL. ${"DIREITO PENAL. ".repeat(8)}`;
    const { documentAst } = parse({
      type: "html",
      text: `<p><strong>${text}</strong></p>`,
    });
    expect(documentAst.blocks.at(0)?.type).toBe("paragraph");
  });
});

describe("a table cell's span", () => {
  test("is kept when the markup states a whole number above one", () => {
    const { documentAst } = parse({
      type: "html",
      text: "<table><tr><td colspan='2'>Órgão julgador</td></tr><tr><td colspan='1'>Turma</td><td colspan='x'>Cível</td></tr></table>",
    });
    const [table] = documentAst.blocks;
    expect(
      table?.type === "table"
        ? table.rows.map((cells) => cells.map(({ colSpan }) => colSpan))
        : [],
    ).toEqual([[2], [undefined, undefined]]);
  });
});

describe("a table's caption", () => {
  test("is kept, before the rows it names", () => {
    const { fulltext } = parse({
      type: "html",
      text: "<table><caption>Quadro de votação</caption><tr><td>Relator</td><td>Vencido</td></tr><tr><td>Revisor</td><td>Vencedor</td></tr></table>",
    });
    expect(fulltext).toContain("Quadro de votação");
    expect(fulltext.indexOf("Quadro de votação")).toBeLessThan(
      fulltext.indexOf("Relator"),
    );
  });
});
