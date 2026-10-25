import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty, propertyTestTimeout } from "@stll/property-testing";

import { brTjdftCompletenessIssues } from "@/api/tests/helpers/br-tjdft-completeness";

import { parseBrTjdftDocument } from "./br-tjdft";
import {
  expectMarkerRetention,
  injectMarkupMarkers,
  markerPlan,
} from "./marker-injection.test-helper";

/**
 * The shapes the court's word-processor HTML and text renderings take,
 * including the ones the HTML parser has to recover from: rows inside an
 * inline element inside a cell, paragraphs inside spans, a layout table per
 * vote, and pipe-bordered text.
 */
const shapes = fc.array(
  fc.constantFrom(
    "<p><span><span><strong>EMENTA</strong></span></span></p>",
    "<p><span> <p> </p><p class='MsoNormal'><span>Texto da ementa.</span></p></span></p>",
    "<table id='tabelaDadosProcesso'><tbody><tr><td><strong>Órgão</strong></td><td>1ª Turma Cível</td></tr><tr><td colspan='2'><span><strong><tr><td><strong>APELANTE(S)</strong></td><td>FULANO DE TAL</td></tr></strong></span></td></tr></tbody></table>",
    "<table><tbody><tr><td><p>O Senhor Desembargador RELATOR</p><p>Voto do relator.</p></td></tr><tr><td><p>A Senhora Desembargadora VOGAL</p>Com o relator</td></tr></tbody></table>",
    "<table><tbody><tr><td><img src='data:image/png;base64,AAAA' alt='' /></td><td><p><span>Poder Judiciário da União<br />TRIBUNAL DE JUSTIÇA</span></p></td></tr></tbody></table>",
    "<pre>|Órgão |1ª Câmara Cível |\n|Relator |Desembargador FULANO |\n\n                    E M E N T A\n\nTexto quebrado em\nduas linhas.\n\n|A C Ó R D Ã O |\n| |\n|Acordam os Desembargadores |\n|em proferir a decisão. |</pre>",
    "<p><em>Itálico</em> e <a href='https://www.tjdft.jus.br'>ligação</a> no texto.</p>",
    "<blockquote><p>Citação de outro julgado.</p></blockquote>",
    "<p>Antes da quebra.<br><br>Depois da quebra.</p>",
    "<p>&#160; </p>",
  ),
  { minLength: 1, maxLength: 8 },
);

test(
  "TJDFT full-text markers retain their source order",
  () => {
    assertProperty(
      "TJDFT full-text markers retain their source order",
      fc.property(markerPlan, shapes, (plan, fragments) => {
        const injected = injectMarkupMarkers({
          source: `<html><body>${fragments.join("")}</body></html>`,
          selector: "body",
          excludedSelector: "script, style",
          plan,
        });
        const parsed = parseBrTjdftDocument({
          content: { type: "html", text: injected.source },
          documentId: "property-fixture",
          caseNumber: "property-fixture",
          court: "Tribunal de Justiça do Distrito Federal e dos Territórios",
          decisionDate: undefined,
          decisionType: undefined,
          sourceUrl: "https://jurisdf.tjdft.jus.br/acordaos/property-fixture",
        });
        expectMarkerRetention(parsed.fulltext, injected.markers);
        expect(
          brTjdftCompletenessIssues(
            injected.source,
            parsed.documentAst.blocks,
          ).filter((code) => code !== "EMPTY_AST"),
        ).toEqual([]);
      }),
      { numRuns: 20 },
    );
  },
  propertyTestTimeout(30_000),
);
