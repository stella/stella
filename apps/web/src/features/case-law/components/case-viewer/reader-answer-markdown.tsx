import { useMemo } from "react";
import type { ReactNode } from "react";

import type { Element, ElementContent, Root } from "hast";

import type {
  ReaderAnswerCitation,
  ReaderAnswerMessage,
} from "@stll/api-contract/reader-answers";

import { MessageResponse } from "@/components/ai-elements/message";
import type { MessageResponseProps } from "@/components/ai-elements/message-response";
import { assistantMessageFallbackText } from "@/components/chat/chat-thread-messages.logic";

const citationMarker = ({ decisionId, paragraphId }: ReaderAnswerCitation) =>
  `[[${decisionId}#${paragraphId}]]`;

const SKIP_TAGS = new Set(["code", "pre", "a", "button", "script", "style"]);

const citationElement = (index: number): Element => ({
  type: "element",
  tagName: "span",
  properties: { dataReaderCitation: index },
  children: [],
});

/** Runs after the shared chat sanitizer, against only the server-verified citations. */
const rehypeReaderAnswerCitations =
  (citations: readonly ReaderAnswerCitation[]) => (tree: Root) => {
    const used = new Set<number>();
    const byMarker = new Map(
      citations.map((citation, index) => [citationMarker(citation), index]),
    );
    const replaceText = (value: string): ElementContent[] => {
      const result: ElementContent[] = [];
      let cursor = 0;
      for (const match of value.matchAll(/\[\[[^\]\n]+\]\]/gu)) {
        const index = byMarker.get(match[0]);
        if (index === undefined) {
          continue;
        }
        if (match.index > cursor) {
          result.push({
            type: "text",
            value: value.slice(cursor, match.index),
          });
        }
        result.push(citationElement(index));
        used.add(index);
        cursor = match.index + match[0].length;
      }
      if (cursor < value.length) {
        result.push({ type: "text", value: value.slice(cursor) });
      }
      return result;
    };
    const walk = (element: Element): void => {
      if (SKIP_TAGS.has(element.tagName)) {
        return;
      }
      element.children = element.children.flatMap((child) => {
        if (child.type === "text") {
          return replaceText(child.value);
        }
        if (child.type === "element") {
          walk(child);
        }
        return [child];
      });
    };
    for (const child of tree.children) {
      if (child.type === "element") {
        walk(child);
      }
    }
    const remaining = citations.flatMap((_, index) =>
      used.has(index) ? [] : [citationElement(index)],
    );
    if (remaining.length > 0) {
      tree.children.push({
        type: "element",
        tagName: "div",
        properties: {
          className: [
            "flex",
            "flex-wrap",
            "items-center",
            "gap-x-2",
            "gap-y-1",
          ],
        },
        children: remaining,
      });
    }
  };

// Deltas carry internal markers before the terminal payload verifies citations.
// Hide only UUID-shaped reader syntax; ordinary wiki-style text stays literal.
const hidePendingReaderMarkers = (value: string): string =>
  value
    .replaceAll(
      /\[{1,2}[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}#[^\]\n]+\]\]/giu,
      "",
    )
    .replace(/\[{1,2}[\da-f]{8}[\da-f-]*(?:#[^\]\n]*)?\]?$/iu, "");

const rehypePendingReaderCitations = () => (tree: Root) => {
  const walk = (element: Element): void => {
    if (element.tagName !== "a" && SKIP_TAGS.has(element.tagName)) {
      return;
    }
    for (const [index, child] of element.children.entries()) {
      if (child.type === "text") {
        child.value = hidePendingReaderMarkers(child.value);
      } else if (child.type === "element") {
        // Streamdown repairs an unfinished [[UUID#paragraph into an anchor
        // whose label loses the opening brackets; recognize that repair too.
        const label = child.children
          .flatMap((part) => (part.type === "text" ? [part.value] : []))
          .join("");
        if (
          child.tagName === "a" &&
          /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}#/iu.test(
            label,
          )
        ) {
          child.tagName = "span";
          child.properties = {};
          child.children = [];
          const previous = element.children.at(index - 1);
          if (index > 0 && previous?.type === "text") {
            previous.value = previous.value.replace(/\[$/u, "");
          }
        } else {
          walk(child);
        }
      }
    }
    // Incomplete Markdown may normalize a trailing reader token into a link.
    // Once its internal label is hidden, retain no empty interactive link.
    if (
      element.tagName === "a" &&
      element.children.every(
        (child) => child.type === "text" && child.value === "",
      )
    ) {
      element.tagName = "span";
      element.properties = {};
    }
  };
  for (const child of tree.children) {
    if (child.type === "element") {
      walk(child);
    }
  }
};

const PENDING_READER_MARKDOWN_OPTIONS = {
  rehypePlugins: [rehypePendingReaderCitations],
} satisfies MessageResponseProps;

type ReaderAnswerMarkdownOptions = {
  citations: readonly ReaderAnswerCitation[];
  renderCitation: (citation: ReaderAnswerCitation) => ReactNode;
};

/** Shares chat's Markdown and safety pipeline; only reader citation syntax is added. */
export const readerAnswerMarkdownOptions = ({
  citations,
  renderCitation,
}: ReaderAnswerMarkdownOptions) => {
  // Verified citations arrive with the terminal payload. Until then, preserve
  // chat's incremental block parsing with one stable marker-hiding plugin.
  if (citations.length === 0) {
    return PENDING_READER_MARKDOWN_OPTIONS;
  }
  return {
    // Inline and fallback chips share one usage scope in the completed answer.
    mode: "static",
    rehypePlugins: [[rehypeReaderAnswerCitations, citations]],
    components: {
      span: ({ node, children, ...props }) => {
        const index = node?.properties["dataReaderCitation"];
        const citation =
          typeof index === "number" ? citations.at(index) : undefined;
        return citation === undefined ? (
          <span {...props}>{children}</span>
        ) : (
          <>{renderCitation(citation)}</>
        );
      },
    },
  } satisfies MessageResponseProps;
};

type ReaderAnswerMarkdownProps = ReaderAnswerMarkdownOptions & {
  content: string;
  status: ReaderAnswerMessage["status"];
};

export const ReaderAnswerMarkdown = ({
  content,
  status,
  citations,
  renderCitation,
}: ReaderAnswerMarkdownProps) => {
  const options = useMemo(
    () =>
      readerAnswerMarkdownOptions({
        citations: citations.filter((citation) =>
          content.includes(citationMarker(citation)),
        ),
        renderCitation,
      }),
    [content, citations, renderCitation],
  );
  let fallback = hidePendingReaderMarkers(content);
  for (const citation of citations) {
    fallback = fallback.replaceAll(citationMarker(citation), "");
  }
  return (
    <>
      <MessageResponse
        {...options}
        className="h-auto min-w-0 wrap-break-word"
        isAnimating={status === "streaming"}
        fallbackChildren={assistantMessageFallbackText(fallback)}
      >
        {content}
      </MessageResponse>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {citations
          .filter((citation) => !content.includes(citationMarker(citation)))
          .map((citation) => (
            <span key={citationMarker(citation)}>
              {renderCitation(citation)}
            </span>
          ))}
      </div>
    </>
  );
};
