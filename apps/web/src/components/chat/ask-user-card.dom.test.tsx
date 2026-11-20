import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import type { AskUserAnswer } from "@stll/api-contract/chat-ask-user";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import type {
  AskUserInput,
  AskUserOutput,
  RegisteredChatUIToolCallPart,
} from "@/components/chat/chat-ui-tools";

GlobalRegistrator.register({ url: "http://localhost:3000/chat" });

const { act } = await import("react");
const { cleanup, fireEvent, render, screen, within } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { default: messages } = await import("@/i18n/langs/en.json");
const { AskUserCard } = await import("@/components/chat/ask-user-card");

afterEach(async () => {
  await act(async () => cleanup());
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

type AskUserPart = Extract<RegisteredChatUIToolCallPart, { name: "ask-user" }>;

const documents = {
  question: "Which documents should I read?",
  reason: "Only picked documents are read.",
  options: ["Lease A", "Lease B", "NDA C"],
  selection: "multiple",
} satisfies AskUserInput["questions"][number];
const side = {
  question: "Which side are you on?",
  reason: "Sets the tiers.",
  options: ["Landlord", "Tenant"],
} satisfies AskUserInput["questions"][number];
const input = {
  analysis: "The builder needs its sources.",
  questions: [documents, side],
} satisfies AskUserInput;

const pendingPart = (questions: AskUserInput["questions"]): AskUserPart => {
  const pending = { analysis: input.analysis, questions };
  return {
    arguments: JSON.stringify(pending),
    id: "tool-call-ask-user",
    input: pending,
    name: "ask-user",
    state: "input-complete",
    type: "tool-call",
  };
};

const answeredPart = (answers: AskUserAnswer[]): AskUserPart => ({
  ...pendingPart(input.questions),
  output: { answers },
  state: "complete",
});

const mountCard = (part: AskUserPart) => {
  const submitted: AskUserOutput[] = [];
  const rerun: AskUserOutput[] = [];
  const view = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <AskUserCard
          isAwaitingUser
          onEditAndRerun={(_id, output) => {
            rerun.push(output);
          }}
          onSubmit={(_id, output) => {
            submitted.push(output);
          }}
          part={part}
        />
      </FormattingProvider>
    </IntlProvider>,
  );
  return { rerun, submitted, view };
};

const button = (name: string) => screen.getByRole("button", { name });
const submitButton = () => button(messages.chat.askUser.submit);
const isDisabled = (element: HTMLElement) =>
  element.hasAttribute("disabled") ||
  element.getAttribute("aria-disabled") === "true";
const selectedCount = (count: number) =>
  count === 1 ? "1 selected" : `${String(count)} selected`;

describe("ask-user card multiple choice", () => {
  test("toggles options, selects all and clears", () => {
    mountCard(pendingPart(input.questions));
    expect(
      screen.getAllByText(messages.chat.localRunQuestion.chooseSeveral),
    ).toHaveLength(1);
    expect(screen.getByText(selectedCount(0))).not.toBeNull();

    fireEvent.click(button("Lease B"));
    fireEvent.click(button("NDA C"));
    fireEvent.click(button("Lease B"));
    expect(button("Lease B").getAttribute("aria-pressed")).toBe("false");
    expect(button("NDA C").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(selectedCount(1))).not.toBeNull();

    fireEvent.click(button(messages.common.selectAll));
    for (const option of documents.options) {
      expect(button(option).getAttribute("aria-pressed")).toBe("true");
    }
    expect(isDisabled(button(messages.common.selectAll))).toBe(true);

    fireEvent.click(button(messages.common.clearSelection));
    for (const option of documents.options) {
      expect(button(option).getAttribute("aria-pressed")).toBe("false");
    }
    expect(isDisabled(button(messages.common.clearSelection))).toBe(true);
  });

  test("sends only once every question is answered, with the ticked options", () => {
    const { submitted } = mountCard(pendingPart(input.questions));
    expect(isDisabled(submitButton())).toBe(true);
    fireEvent.click(button("NDA C"));
    expect(isDisabled(submitButton())).toBe(true);
    fireEvent.click(button("Tenant"));
    expect(isDisabled(submitButton())).toBe(false);
    fireEvent.click(button("Lease A"));
    fireEvent.click(submitButton());

    expect(submitted).toEqual([
      {
        answers: [
          { question: documents.question, selected: ["Lease A", "NDA C"] },
          { question: side.question, answer: "Tenant" },
        ],
      },
    ]);
  });

  test("Enter on a ticked option sends the card", () => {
    const { submitted } = mountCard(pendingPart(input.questions));
    fireEvent.click(button("Tenant"));
    fireEvent.click(button("Lease B"));
    fireEvent.keyDown(button("Lease B"), { key: "Enter" });
    expect(submitted.at(0)?.answers.at(0)).toEqual({
      question: documents.question,
      selected: ["Lease B"],
    });
  });

  test("a single-choice question also needs an answer before sending", () => {
    const { submitted } = mountCard(
      pendingPart([{ question: "Anything else?", reason: "Scope." }]),
    );
    expect(isDisabled(submitButton())).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: " " } });
    expect(isDisabled(submitButton())).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "No" },
    });
    fireEvent.click(submitButton());
    expect(submitted).toEqual([
      { answers: [{ question: "Anything else?", answer: "No" }] },
    ]);
  });

  test("renders many options as a checkbox list", () => {
    const options = Array.from(
      { length: 11 },
      (_, index) => `Contract ${String(index + 1)}`,
    );
    const { submitted } = mountCard(pendingPart([{ ...documents, options }]));
    expect(screen.getAllByRole("checkbox")).toHaveLength(options.length);
    fireEvent.click(screen.getByText("Contract 3"));
    fireEvent.click(screen.getByText("Contract 11"));
    fireEvent.click(submitButton());
    expect(submitted).toEqual([
      {
        answers: [
          {
            question: documents.question,
            selected: ["Contract 3", "Contract 11"],
          },
        ],
      },
    ]);
  });

  test("lists the ticked options once answered", () => {
    mountCard(
      answeredPart([
        { question: documents.question, selected: ["Lease A", "NDA C"] },
        { question: side.question, answer: "Tenant" },
      ]),
    );
    const ticked = screen.getByText("Lease A").closest("ul");
    expect(ticked).not.toBeNull();
    const items = ticked ? within(ticked).getAllByRole("listitem") : [];
    expect(items.map((item) => item.textContent)).toEqual(["Lease A", "NDA C"]);
    expect(screen.getByText("Tenant")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Lease A" })).toBeNull();
  });

  test("Edit answers re-ticks stored options", () => {
    const { rerun } = mountCard(
      answeredPart([
        { question: documents.question, selected: ["Lease A", "NDA C"] },
        { question: side.question, answer: "Tenant" },
      ]),
    );
    fireEvent.click(button(messages.chat.askUser.edit));
    expect(button("Lease A").getAttribute("aria-pressed")).toBe("true");
    expect(button("Lease B").getAttribute("aria-pressed")).toBe("false");
    expect(button("NDA C").getAttribute("aria-pressed")).toBe("true");
    expect(button("Tenant").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button("NDA C"));
    fireEvent.click(button(messages.chat.askUser.rerun));
    expect(rerun).toEqual([
      {
        answers: [
          { question: documents.question, selected: ["Lease A"] },
          { question: side.question, answer: "Tenant" },
        ],
      },
    ]);
  });

  test("Edit answers reopens answers stored before selections, blank ones too", () => {
    const { rerun } = mountCard(
      answeredPart([
        { question: documents.question, answer: "Every lease" },
        { question: side.question, answer: "" },
      ]),
    );
    expect(screen.getByText("Every lease")).not.toBeNull();
    expect(screen.getByText(messages.chat.askUser.noAnswer)).not.toBeNull();

    fireEvent.click(button(messages.chat.askUser.edit));
    const ownWords = screen.getByRole("textbox");
    expect(ownWords.getAttribute("value")).toBe("Every lease");
    expect(button("Landlord").getAttribute("aria-pressed")).toBe("false");
    expect(button("Tenant").getAttribute("aria-pressed")).toBe("false");
    expect(isDisabled(button(messages.chat.askUser.rerun))).toBe(true);
    fireEvent.click(button("Landlord"));
    fireEvent.click(button(messages.chat.askUser.rerun));
    expect(rerun).toEqual([
      {
        answers: [
          { question: documents.question, answer: "Every lease" },
          { question: side.question, answer: "Landlord" },
        ],
      },
    ]);
  });
});
