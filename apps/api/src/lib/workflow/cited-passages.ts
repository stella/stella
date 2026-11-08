import { panic } from "better-result";

import type { JustificationContent } from "@/api/db/schema";
import { sanitizeForPrompt, untrustedText } from "@/api/lib/prompt-safety";

/**
 * The exact wording of every verified block a justification cites. Only a
 * verified citation holds text the server looked up; an unverified one is
 * whatever the model typed, and a Bates citation points at a page with no text.
 *
 * An answer that also cites a PDF yields no passages. Its PDF terms exist only
 * in the answer, so grading the DOCX passages alone would miss them.
 */
export const verifiedPassageTexts = (
  content: JustificationContent,
): string[] => {
  const texts: string[] = [];
  for (const block of content.blocks) {
    switch (block.kind) {
      case "docx-folio":
        for (const statement of block.statements) {
          for (const citation of statement.citations) {
            if (citation.citationStatus === "verified") {
              texts.push(citation.text);
            }
          }
        }
        break;
      case "pdf-bates":
        return [];
      case "playbook-verdict":
      case "decision-passage":
        break;
      default:
        block satisfies never;
        panic(`Unhandled block: ${String(block)}`);
    }
  }
  return texts;
};

type SharedPassages<Item> = {
  /** One entry per distinct passage; its number is its index plus one. */
  unique: string[];
  /** Each input with the labels of its passages, in citation order. */
  labeled: { item: Item; labels: string[] }[];
};

/**
 * One list per grading call, so a block cited by five positions is sent once
 * and the passages of a call can never exceed the document they came from.
 */
export const sharePassages = <Item extends { passages: readonly string[] }>(
  items: readonly Item[],
): SharedPassages<Item> => {
  const labelByText = new Map<string, string>();
  const unique: string[] = [];
  const labeled = items.map((item) => {
    const labels = new Set<string>();
    for (const text of item.passages) {
      if (text.trim().length === 0) {
        continue;
      }
      let label = labelByText.get(text);
      if (label === undefined) {
        unique.push(text);
        label = `P${String(unique.length)}`;
        labelByText.set(text, label);
      }
      labels.add(label);
    }
    return { item, labels: [...labels] };
  });
  return { unique, labeled };
};

export const buildPassageListMessage = (unique: readonly string[]): string =>
  [
    "Contract passages, each one exact text from the contract:",
    ...unique.map(
      (text, index) =>
        `P${String(index + 1)}:\n${sanitizeForPrompt(untrustedText(text))}`,
    ),
  ].join("\n");
