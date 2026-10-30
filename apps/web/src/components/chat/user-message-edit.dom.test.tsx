import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/chat" });

const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { TooltipProvider } = await import("@stll/ui/tooltip");
const { EditableUserMessage } = await import("./user-message-edit");
const en = (await import("@/i18n/langs/en.json")).default;

afterEach(cleanup);
afterAll(async () => {
  await unregisterDomEnvironment();
});

type EditableUserMessageProps = Parameters<typeof EditableUserMessage>[0];
type UserMessageEditActions = NonNullable<EditableUserMessageProps["actions"]>;

const MESSAGE_ID = "018f0000-0000-7000-8000-0000000000a2";
/** The message body the transcript renders when no edit is open. */
const SENT_BODY = "Sent message body";

const ndaDocument = {
  metadata: { filename: "nda.pdf" },
  source: {
    mimeType: "application/pdf",
    type: "url" as const,
    value: "/v1/user-files/018f0000-0000-7000-8000-0000000000f1",
  },
  type: "document" as const,
};

const message: EditableUserMessageProps["message"] = {
  id: MESSAGE_ID,
  parts: [{ type: "text", content: "Review the **draft** NDA" }, ndaDocument],
  role: "user",
};

/** Actions that record what the message asked for. */
const createActions = () => {
  const started: true[] = [];
  const submitted: Parameters<UserMessageEditActions["onSubmit"]>[] = [];
  const actions: UserMessageEditActions = {
    onStart: () => {
      started.push(true);
    },
    onSubmit: async (...call) => {
      submitted.push(call);
      await Promise.resolve();
    },
  };
  return { actions, started, submitted };
};

const renderMessage = ({
  actions,
  isGenerating = false,
  target = message,
}: {
  actions: UserMessageEditActions | undefined;
  isGenerating?: boolean;
  target?: EditableUserMessageProps["message"];
}) =>
  render(
    <IntlProvider locale="en" messages={en}>
      <TooltipProvider>
        <EditableUserMessage
          actions={actions}
          isGenerating={isGenerating}
          message={target}
        >
          <p>{SENT_BODY}</p>
        </EditableUserMessage>
      </TooltipProvider>
    </IntlProvider>,
  );

const openEditor = (view: ReturnType<typeof renderMessage>) => {
  fireEvent.click(view.getByRole("button", { name: en.chat.editMessage }));
  const field = view.getByRole("textbox", { name: en.chat.editMessageInput });
  if (!(field instanceof HTMLTextAreaElement)) {
    throw new TypeError("The edit field is a text area");
  }
  return field;
};

describe("editing a sent message", () => {
  test("opens on the message's text and attachments, stopping a running turn first", () => {
    const { actions, started } = createActions();
    const view = renderMessage({ actions });

    const field = openEditor(view);

    expect(started).toHaveLength(1);
    expect(field.value).toBe("Review the draft NDA");
    expect(view.queryByText(SENT_BODY)).toBeNull();
    expect(
      view.getByRole("button", {
        name: en.chat.editMessageRemoveAttachment.replace("{name}", "nda.pdf"),
      }),
    ).toBeDefined();
    expect(view.getByText(en.chat.editMessageNotice)).toBeDefined();
  });

  test("cancel puts the message back as it was", () => {
    const { actions, submitted } = createActions();
    const view = renderMessage({ actions });

    fireEvent.change(openEditor(view), {
      target: { value: "Something else" },
    });
    fireEvent.click(view.getByRole("button", { name: en.common.cancel }));

    expect(view.getByText(SENT_BODY)).toBeDefined();
    expect(submitted).toEqual([]);
    // The next edit starts from the message again, not the abandoned draft.
    expect(openEditor(view).value).toBe("Review the draft NDA");
  });

  test("escape cancels the edit", () => {
    const { actions, submitted } = createActions();
    const view = renderMessage({ actions });

    fireEvent.keyDown(openEditor(view), { key: "Escape" });

    expect(view.getByText(SENT_BODY)).toBeDefined();
    expect(submitted).toEqual([]);
  });

  test("send replaces the message with the edited text and the kept attachments", () => {
    const { actions, submitted } = createActions();
    const view = renderMessage({ actions });

    fireEvent.change(openEditor(view), {
      target: { value: "Review the signed NDA" },
    });
    fireEvent.click(
      view.getByRole("button", {
        name: en.chat.editMessageRemoveAttachment.replace("{name}", "nda.pdf"),
      }),
    );
    fireEvent.click(view.getByRole("button", { name: en.chat.sendPrompt }));

    expect(submitted).toHaveLength(1);
    expect(submitted.at(0)).toEqual([
      MESSAGE_ID,
      { attachments: [], chips: [], text: "Review the signed NDA" },
    ]);
    // The form closes; the sent copy takes the message's place.
    expect(
      view.queryByRole("textbox", { name: en.chat.editMessageInput }),
    ).toBeNull();
  });

  test("enter sends, shift and enter starts a new line", () => {
    const { actions, submitted } = createActions();
    const view = renderMessage({ actions });
    const field = openEditor(view);

    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    expect(submitted).toEqual([]);

    fireEvent.keyDown(field, { key: "Enter" });
    expect(submitted).toHaveLength(1);
  });

  test("waits for a running turn to stop, and for something to send", () => {
    const { actions, submitted } = createActions();
    const running = renderMessage({ actions, isGenerating: true });
    openEditor(running);
    const send = running.getByRole("button", { name: en.chat.sendPrompt });
    expect(
      send.hasAttribute("disabled") ||
        send.getAttribute("aria-disabled") === "true",
    ).toBe(true);
    fireEvent.click(send);
    expect(submitted).toEqual([]);
    cleanup();

    const idle = renderMessage({ actions });
    fireEvent.change(openEditor(idle), { target: { value: "   " } });
    fireEvent.click(
      idle.getByRole("button", {
        name: en.chat.editMessageRemoveAttachment.replace("{name}", "nda.pdf"),
      }),
    );
    fireEvent.click(idle.getByRole("button", { name: en.chat.sendPrompt }));
    expect(submitted).toEqual([]);
  });

  test("a just-sent message keeps its mention chips as tokens", () => {
    const { actions, submitted } = createActions();
    const view = renderMessage({
      actions,
      target: {
        id: MESSAGE_ID,
        parts: [
          {
            type: "text",
            content:
              '<p>Compare <entity-mention data-id="018f0000-0000-7000-8000-0000000000d1" data-label="NDA.docx" data-category="entity"></entity-mention> today</p>',
          },
        ],
        role: "user",
      },
    });

    const field = openEditor(view);
    expect(field.value).toBe("Compare @NDA.docx today");

    fireEvent.click(view.getByRole("button", { name: en.chat.sendPrompt }));
    const [, draft] = submitted.at(0) ?? [];
    expect(draft?.chips.map(({ token }) => token)).toEqual(["@NDA.docx"]);
    expect(draft?.chips.at(0)?.html).toContain('data-label="NDA.docx"');
  });

  test("a stored message opening with an autolink or a literal < opens intact", () => {
    for (const [stored, editable] of [
      [
        "<https://example.com/terms> has the terms",
        "https://example.com/terms has the terms",
      ],
      ["<3 thanks for the draft", "<3 thanks for the draft"],
    ] as const) {
      const view = renderMessage({
        actions: createActions().actions,
        target: {
          id: MESSAGE_ID,
          parts: [{ type: "text", content: stored }],
          role: "user",
        },
      });
      expect(openEditor(view).value).toBe(editable);
      cleanup();
    }
  });

  test("offers no edit without actions or on another role", () => {
    const withoutActions = renderMessage({ actions: undefined });
    expect(
      withoutActions.queryByRole("button", { name: en.chat.editMessage }),
    ).toBeNull();
    cleanup();

    const assistant = renderMessage({
      actions: createActions().actions,
      target: { ...message, role: "assistant" },
    });
    expect(
      assistant.queryByRole("button", { name: en.chat.editMessage }),
    ).toBeNull();
    expect(assistant.getByText(SENT_BODY)).toBeDefined();
  });
});
