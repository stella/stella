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

const REMOVE_NDA = en.chat.editMessageRemoveAttachment.replace(
  "{name}",
  "nda.pdf",
);

const openEditor = (view: ReturnType<typeof renderMessage>) => {
  fireEvent.click(view.getByRole("button", { name: en.chat.editMessage }));
  return view.getByRole("textbox", { name: en.chat.editMessageInput });
};

describe("editing a sent message", () => {
  test("opens on the message's content and attachments, stopping a running turn first", () => {
    const { actions, started } = createActions();
    const view = renderMessage({ actions });

    const field = openEditor(view);

    expect(started).toHaveLength(1);
    expect(field.textContent).toBe("Review the draft NDA");
    // Bold text opens bold, as the composer holds it.
    expect(field.querySelector("strong")?.textContent).toBe("draft");
    expect(view.queryByText(SENT_BODY)).toBeNull();
    expect(view.getByRole("button", { name: REMOVE_NDA })).toBeDefined();
    expect(view.getByText(en.chat.editMessageNotice)).toBeDefined();
  });

  test("cancel puts the message back as it was", () => {
    const { actions, submitted } = createActions();
    const view = renderMessage({ actions });

    openEditor(view);
    fireEvent.click(view.getByRole("button", { name: REMOVE_NDA }));
    fireEvent.click(view.getByRole("button", { name: en.common.cancel }));

    expect(view.getByText(SENT_BODY)).toBeDefined();
    expect(submitted).toEqual([]);
    // The next edit starts from the message again, attachment included.
    openEditor(view);
    expect(view.getByRole("button", { name: REMOVE_NDA })).toBeDefined();
  });

  test("escape cancels the edit", () => {
    const { actions, submitted } = createActions();
    const view = renderMessage({ actions });

    fireEvent.keyDown(openEditor(view), { key: "Escape" });

    expect(view.getByText(SENT_BODY)).toBeDefined();
    expect(submitted).toEqual([]);
  });

  test("send writes the composer's markup and the kept attachments", () => {
    const { actions, submitted } = createActions();
    const view = renderMessage({ actions });

    openEditor(view);
    fireEvent.click(view.getByRole("button", { name: REMOVE_NDA }));
    fireEvent.click(view.getByRole("button", { name: en.chat.sendPrompt }));

    expect(submitted).toEqual([
      [
        MESSAGE_ID,
        {
          attachments: [],
          html: "<p>Review the <strong>draft</strong> NDA</p>",
        },
      ],
    ]);
    // The form closes; the sent copy takes the message's place.
    expect(
      view.queryByRole("textbox", { name: en.chat.editMessageInput }),
    ).toBeNull();
  });

  test("enter sends", () => {
    const { actions, submitted } = createActions();
    const view = renderMessage({ actions });

    fireEvent.keyDown(openEditor(view), { key: "Enter" });

    expect(submitted.at(0)?.[1]).toEqual({
      attachments: [ndaDocument],
      html: "<p>Review the <strong>draft</strong> NDA</p>",
    });
  });

  test("a numbered list the user typed comes back with its numbers", () => {
    const { actions, submitted } = createActions();
    const view = renderMessage({
      actions,
      target: {
        id: MESSAGE_ID,
        parts: [{ type: "text", content: "1. Parties  \n2. Term" }],
        role: "user",
      },
    });

    expect(openEditor(view).textContent).toBe("1. Parties2. Term");
    fireEvent.click(view.getByRole("button", { name: en.chat.sendPrompt }));
    expect(submitted.at(0)?.[1].html).toBe("<p>1. Parties<br>2. Term</p>");
  });

  test("a just-sent message opens from the composer markup it holds", () => {
    const { actions, submitted } = createActions();
    const view = renderMessage({
      actions,
      target: {
        id: MESSAGE_ID,
        parts: [{ type: "text", content: "<p>Just <strong>sent</strong></p>" }],
        role: "user",
      },
    });

    openEditor(view);
    fireEvent.click(view.getByRole("button", { name: en.chat.sendPrompt }));
    expect(submitted.at(0)?.[1].html).toBe("<p>Just <strong>sent</strong></p>");
  });

  test("waits for a running turn to stop", () => {
    const { actions, submitted } = createActions();
    const view = renderMessage({ actions, isGenerating: true });

    openEditor(view);
    const send = view.getByRole("button", { name: en.chat.sendPrompt });
    expect(
      send.hasAttribute("disabled") ||
        send.getAttribute("aria-disabled") === "true",
    ).toBe(true);
    fireEvent.click(send);
    expect(submitted).toEqual([]);
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
