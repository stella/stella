import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import en from "@/i18n/langs/en.json";
import { toSafeId } from "@/lib/safe-id";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register();
const { cleanup, render } = await import("@testing-library/react");
const { MessageResponseImpl } =
  await import("@/components/ai-elements/message-response");
const { readerAnswerMarkdownOptions } =
  await import("./reader-answer-markdown");

afterEach(cleanup);
afterAll(unregisterDomEnvironment);

const citation = {
  decisionId: toSafeId<"caseLawDecision">(
    "00000000-0000-4000-8000-000000000003",
  ),
  paragraphId: "p-3",
};
const marker = `[[${citation.decisionId}#${citation.paragraphId}]]`;
const renderCitation = ({ paragraphId }: typeof citation) => (
  <button type="button" data-citation={paragraphId}>
    {paragraphId}
  </button>
);

test("live unverified deltas hide internal markers until verified inline chips arrive", () => {
  const pending = readerAnswerMarkdownOptions({
    citations: [],
    renderCitation,
  });
  expect(
    readerAnswerMarkdownOptions({ citations: [], renderCitation })
      .rehypePlugins,
  ).toBe(pending.rehypePlugins);
  const content = `- **Conclusion** ${marker}\n- *Reasoning*`;
  const { container, rerender } = render(
    <MessageResponseImpl {...pending} isAnimating>
      {content}
    </MessageResponseImpl>,
  );
  expect(container.innerHTML).not.toContain(citation.decisionId);
  expect(container.textContent).not.toContain("[[");
  expect(container.querySelector("[data-citation]")).toBeNull();
  expect(container.querySelectorAll("li")).toHaveLength(2);
  expect(
    container.querySelector('[data-streamdown="strong"]')?.textContent,
  ).toBe("Conclusion");
  expect(container.querySelector("em")?.textContent).toBe("Reasoning");
  const prose = [...container.querySelectorAll("li")].map(
    (item) => item.textContent,
  );
  rerender(
    <MessageResponseImpl
      {...readerAnswerMarkdownOptions({
        citations: [citation],
        renderCitation,
      })}
      isAnimating={false}
    >
      {content}
    </MessageResponseImpl>,
  );
  expect(container.innerHTML).not.toContain(citation.decisionId);
  expect(container.textContent).not.toContain("[[");
  expect(container.querySelectorAll("[data-citation]")).toHaveLength(1);
  expect(container.querySelectorAll("li")).toHaveLength(2);
  expect(
    container.querySelector('[data-streamdown="strong"]')?.textContent,
  ).toBe("Conclusion");
  expect(container.querySelector("em")?.textContent).toBe("Reasoning");
  expect(
    [...container.querySelectorAll("li")].map((item) =>
      item.textContent.replace("p-3", ""),
    ),
  ).toEqual(prose);
});

test("partial trailing reader tokens stay hidden across incremental deltas and code stays literal", () => {
  const pending = readerAnswerMarkdownOptions({
    citations: [],
    renderCitation,
  });
  const initial = "**Conclusion**";
  const { container, rerender } = render(
    <MessageResponseImpl {...pending} isAnimating>
      {initial}
    </MessageResponseImpl>,
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={new QueryClient()}>
          <IntlProvider locale="en" messages={en}>
            {children}
          </IntlProvider>
        </QueryClientProvider>
      ),
    },
  );
  for (const partial of [
    marker.slice(0, 12),
    marker.slice(0, -4),
    marker.slice(0, -1),
    marker,
  ]) {
    rerender(
      <MessageResponseImpl
        {...pending}
        isAnimating
      >{`**Conclusion** ${partial}`}</MessageResponseImpl>,
    );
    expect(container.textContent).not.toContain("[[");
    expect(container.innerHTML).not.toContain(citation.decisionId);
    expect(container.querySelector("[data-citation]")).toBeNull();
  }
  rerender(
    <MessageResponseImpl {...pending}>{`\`${marker}\``}</MessageResponseImpl>,
  );
  expect(container.querySelector("code")?.textContent).toBe(marker);
});
