import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { afterAll, describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import type {
  AskUserInput,
  RegisteredChatUIToolCallPart,
} from "@/components/chat/chat-ui-tools";
import messages from "@/i18n/langs/en.json";

type AskUserPart = Extract<RegisteredChatUIToolCallPart, { name: "ask-user" }>;

const previousApiUrl = process.env["VITE_API_URL"];
process.env["VITE_API_URL"] = previousApiUrl ?? "https://api.example.test";

const { AskUserCard } = await import("@/components/chat/ask-user-card");

afterAll(() => {
  if (previousApiUrl === undefined) {
    delete process.env["VITE_API_URL"];
    return;
  }

  process.env["VITE_API_URL"] = previousApiUrl;
});

const renderWithIntl = (children: ReactNode) =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      {children}
    </IntlProvider>,
  );

const createAskUserPart = (
  questions: AskUserInput["questions"],
): AskUserPart => {
  const input: AskUserInput = {
    analysis: "Need a clarification before continuing.",
    questions,
  };

  return {
    arguments: JSON.stringify(input),
    id: "tool-call-ask-user",
    input,
    state: "input-complete",
    name: "ask-user",
    type: "tool-call",
  } satisfies AskUserPart;
};

describe("ask-user clarification card", () => {
  test("renders free-text prompts as a submit form", () => {
    const html = renderWithIntl(
      <AskUserCard
        onSubmit={() => {}}
        part={createAskUserPart([
          {
            question: "Which jurisdiction should I use?",
            reason: "The answer changes the legal analysis.",
          },
        ])}
      />,
    );

    expect(html).toContain("<form");
    expect(html).toContain('type="text"');
    expect(html).toContain('type="submit"');
    expect(html).toContain(">Submit answers</button>");
  });

  test("keeps option chips out of form submission semantics", () => {
    const html = renderWithIntl(
      <AskUserCard
        onSubmit={() => {}}
        part={createAskUserPart([
          {
            options: ["Czech law", "Spanish law"],
            question: "Which jurisdiction should I use?",
            reason: "The answer changes the legal analysis.",
          },
        ])}
      />,
    );

    expect(html).toContain('type="submit"');
    expect(html).toContain('type="button">Czech law</button>');
    expect(html).toContain('type="button">Spanish law</button>');
  });
});
