import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";

import type { ReaderAnswerCitation } from "@stll/api-contract/reader-answers";

import { MessageResponseImpl } from "@/components/ai-elements/message-response";
import { toSafeId } from "@/lib/safe-id";

import { readerAnswerMarkdownOptions } from "./reader-answer-markdown";

const citation = {
  decisionId: toSafeId<"caseLawDecision">(
    "00000000-0000-4000-8000-000000000003",
  ),
  paragraphId: "p-3",
} satisfies ReaderAnswerCitation;
const marker = `[[${citation.decisionId}#${citation.paragraphId}]]`;
const renderAnswer = (
  content: string,
  streaming: boolean,
  citations = [citation],
) =>
  renderToStaticMarkup(
    <MessageResponseImpl
      {...readerAnswerMarkdownOptions({
        citations,
        renderCitation: ({ paragraphId }) => (
          <button type="button" data-citation={paragraphId}>
            {paragraphId}
          </button>
        ),
      })}
      isAnimating={streaming}
    >
      {content}
    </MessageResponseImpl>,
  );

test("verified reader markers become inline chips in streamed and reloaded Markdown", () => {
  const content = `- **Legal conclusion** ${marker}\n- *Further reasoning*\n\nAnother paragraph ${marker}`;
  const outputs = [true, false].map((streaming) =>
    renderAnswer(content, streaming),
  );
  expect(outputs.at(0)).toBe(outputs.at(1));
  for (const html of outputs) {
    expect(html).toContain("<ul");
    expect(html).toContain('data-streamdown="strong"');
    expect(html).toContain("<em");
    expect(html).not.toContain(citation.decisionId);
    expect(html).not.toContain("[[");
    expect(html.match(/data-citation=/gu)).toHaveLength(2);
    expect(html.indexOf('data-citation="p-3"')).toBeLessThan(
      html.indexOf("Further reasoning"),
    );
  }
});

test("citations without prose markers retain their footer chips", () => {
  const html = renderAnswer("**An answer without an inline marker.**", false);
  expect(html).toContain('data-citation="p-3"');
  expect(html.indexOf('data-citation="p-3"')).toBeGreaterThan(
    html.indexOf("An answer"),
  );
});

test("code markers remain literal and unverified markers never become chips", () => {
  const html = renderAnswer(
    `\`${marker}\`\n\n\`\`\`text\n${marker}\n\`\`\`\n\n[[unverified#p-99]]`,
    false,
  );
  expect(html).toContain("<code");
  expect(html).toContain("[[unverified#p-99]]");
  expect(html.match(/data-citation=/gu)).toHaveLength(1);
});
