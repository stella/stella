import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { afterAll, describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import type { AskUserInput, ChatPart } from "@/components/chat/chat-ui-tools";
import { withParsedToolCallInputs } from "@/components/chat/chat-ui-tools";
import messages from "@/i18n/langs/en.json";
import type Messages from "@/i18n/langs/messages.gen";

type AskUserPart = Extract<ChatPart, { name: "ask-user" }>;

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
    <IntlProvider
      locale="en"
      // SAFETY: this mirrors the app provider boundary; locale
      // files are checked separately, while use-intl preserves
      // English literal values in the generated Messages type.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      messages={messages as Messages}
      timeZone="UTC"
    >
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

  test("renders questions from an arguments-only part after normalization", () => {
    // Reproduces the persisted/streamed shape TanStack emits: a valid
    // `arguments` JSON string and no `input` field. Without the
    // `withParsedToolCallInputs` boundary fill the card collapses to a
    // bare "Request clarification" header with no questions.
    const input: AskUserInput = {
      analysis: "Need a clarification before continuing.",
      questions: [
        {
          question: "Which jurisdiction should I use?",
          reason: "The answer changes the legal analysis.",
        },
      ],
    };
    const argumentsOnlyPart = {
      arguments: JSON.stringify(input),
      id: "tool-call-ask-user",
      state: "input-complete",
      name: "ask-user",
      type: "tool-call",
    } satisfies AskUserPart;

    const [message] = withParsedToolCallInputs([
      { id: "message-1", parts: [argumentsOnlyPart], role: "assistant" },
    ]);
    const normalized = message?.parts[0];
    if (normalized?.type !== "tool-call" || normalized.name !== "ask-user") {
      throw new Error("Expected a normalized ask-user tool-call part");
    }

    const html = renderWithIntl(
      <AskUserCard onSubmit={() => {}} part={normalized} />,
    );

    expect(html).toContain("<form");
    expect(html).toContain('type="submit"');
    expect(html).toContain("Which jurisdiction should I use?");
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
