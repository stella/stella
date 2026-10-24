import { expect, test } from "bun:test";
import fc from "fast-check";

import type { GuidanceMetadata } from "@stll/legal-ast/document-ast";
import { assertProperty } from "@stll/property-testing";

import { buildHtmlDocumentAst } from "./html-document-ast";

const METADATA = {
  type: "guidance",
  kind: "guideline",
  title: "Text preservation",
  reference: "Text preservation",
  issuedOn: "2026-01-15",
  issuer: { type: "authority", name: "Test authority", jurisdiction: "EU" },
} satisfies GuidanceMetadata;

const kinds = [
  "text",
  "header",
  "footer",
  "headingLink",
  "noteMarker",
  "noteDescription",
  "missingLink",
] as const;

test("HTML document building preserves every non-marker text run", () => {
  assertProperty(
    "HTML document building preserves every non-marker text run",
    fc.property(
      fc.array(fc.constantFrom(...kinds), { minLength: 1, maxLength: 30 }),
      (generatedKinds) => {
        const allKinds = [...kinds, ...generatedKinds];
        const expected: string[] = ["PreservationHeading"];
        const paragraphs = allKinds.map((kind, index) => {
          const token = `kept${String(index)}text`;
          switch (kind) {
            case "text": {
              expected.push(token);
              return `<p>${token}</p>`;
            }
            case "header":
            case "footer": {
              expected.push(token);
              return `<${kind}><p>${token}</p></${kind}>`;
            }
            case "headingLink": {
              expected.push(token);
              return `<p><a href="#preservation">${token}</a></p>`;
            }
            case "noteMarker": {
              return `<p><a href="#fn1">[1]</a></p>`;
            }
            case "noteDescription": {
              expected.push(token);
              return `<p><a href="#fn1">${token}</a></p>`;
            }
            case "missingLink": {
              expected.push(token);
              return `<p><a href="#missing">${token}</a></p>`;
            }
            default: {
              kind satisfies never;
              return "";
            }
          }
        });
        expected.push("keptNoteText");
        const html = `<article id="text"><h2 id="preservation">PreservationHeading</h2>${paragraphs.join("")}<aside id="fn1" role="doc-footnote">keptNoteText <a href="#preservation" role="doc-backlink">back</a></aside></article>`;
        const ast = buildHtmlDocumentAst({
          html,
          contentRoot: "#text",
          baseUrl: "https://publisher.test/document",
          source: {
            system: "publisher.test",
            documentId: "text-preservation",
            webUrl: "https://publisher.test/document",
            printUrl: "",
          },
          metadata: METADATA,
        }).unwrap();
        const output = ast.blocks.map((block) => block.plainText).join("\n");
        let priorIndex = -1;
        for (const text of expected) {
          const index = output.indexOf(text, priorIndex + 1);
          expect(index).toBeGreaterThan(priorIndex);
          priorIndex = index;
        }
      },
    ),
  );
});
