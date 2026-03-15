import { Result } from "better-result";
import * as slimdom from "slimdom";

import { ParseXmlError } from "@/api/lib/errors/tagged-errors";

const isElementNode = (node: slimdom.Node): node is slimdom.Element =>
  node.nodeType === node.ELEMENT_NODE;

export type JustificationFilenames = {
  original: string;
  simplified: string;
  fileFieldId: string;
}[];

type ParseJustificationXmlProps = {
  xml: string;
  filenames: JustificationFilenames;
};

export type ParsedJustificationXml = {
  htmlVersion: number;
  htmlContent: string;
  fileFieldIds: string[];
};

/**
 * Parse justification XML produced by the AI model.
 *
 * Multiple `<j f="F0">` elements (one per source file) are
 * merged into a single HTML string. Each citation `<span>`
 * receives a `data-page-number` attribute for page navigation.
 */
export const parseJustificationXml = ({
  xml,
  filenames,
}: ParseJustificationXmlProps) =>
  Result.try({
    try: (): ParsedJustificationXml | null => {
      const document = slimdom.parseXmlDocument(
        `<root>${xml.replaceAll(`\\"`, `"`)}</root>`,
      );

      // eslint-disable-next-line unicorn/prefer-query-selector -- slimdom XML document does not support querySelectorAll
      const justificationElements = document.getElementsByTagName("j");

      const htmlParts: string[] = [];
      const fileFieldIdSet = new Set<string>();

      for (const justificationElement of justificationElements) {
        const filename = justificationElement.getAttribute("f");
        const fileFieldId = filenames.find(
          (f) => f.simplified === filename,
        )?.fileFieldId;

        if (!fileFieldId) {
          continue;
        }

        fileFieldIdSet.add(fileFieldId);

        const elements = justificationElement.childNodes;

        for (const element of elements) {
          if (!isElementNode(element)) {
            continue;
          }

          const tagParts = element.tagName.split("-");
          const tagName = tagParts[0];
          const pageId = tagParts[2];
          const pageNumber = pageId !== undefined ? +pageId : Number.NaN;

          if (!tagName || Number.isNaN(pageNumber)) {
            const previousSibling = element.previousSibling;
            if (previousSibling?.textContent) {
              previousSibling.textContent =
                previousSibling.textContent.trimEnd();
            }
            element.remove();
            continue;
          }

          const page = pageNumber.toString();
          const span = document.createElement("span");
          span.textContent = page;
          // eslint-disable-next-line unicorn/prefer-dom-node-dataset -- slimdom Element does not have dataset
          span.setAttribute("data-page-number", page);
          // eslint-disable-next-line unicorn/prefer-dom-node-dataset -- slimdom Element does not have dataset
          span.setAttribute("data-field-id", fileFieldId);
          element.replaceWith(span);
        }

        htmlParts.push(justificationElement.innerHTML);
      }

      if (htmlParts.length === 0) {
        return null;
      }

      return {
        htmlVersion: 1,
        htmlContent: htmlParts.join(""),
        fileFieldIds: [...fileFieldIdSet],
      };
    },
    catch: (error) =>
      new ParseXmlError({
        message: "Failed to parse justification XML",
        cause: error,
      }),
  });
