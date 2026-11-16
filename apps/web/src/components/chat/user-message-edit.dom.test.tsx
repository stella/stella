import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import { CHAT_MESSAGE_EDIT_ERROR_CODE } from "@stll/api-contract";
import { createChatPastedTextPart } from "@stll/api-contract/chat";
import type {
  ChatLocalFilesUndoAnswer,
  ChatLocalFilesUndoRead,
} from "@stll/api-contract/chat-local-files-undo";
import { htmlToMarkdown } from "@stll/chat/html-to-markdown";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import { PASTED_TEXT_CHIP_MAX_LINES } from "@/components/chat-pasted-text";
import type {
  UserMessageEdit,
  UserMessageEditOutcome,
} from "@/components/chat/user-message-edit.logic";
import { createUuid } from "@/lib/uuid";

GlobalRegistrator.register({ url: "http://localhost:3000/chat" });

const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { TooltipProvider } = await import("@stll/ui/tooltip");
const { stellaToast } = await import("@stll/ui/toast");
const { EditableUserMessage } = await import("./user-message-edit");
const { createUserMessageEditSessions } =
  await import("@/components/chat/user-message-edit.logic");
const { ChatThreadTestRouter } = await import("@/lib/chat-thread-test-router");
const { hasUnsavedWork } = await import("@/hooks/use-unsaved-work");
const en = (await import("@/i18n/langs/en.json")).default;

const THREAD_ID = "018f0000-0000-7000-8000-0000000000a1";
const MESSAGE_ID = "018f0000-0000-7000-8000-0000000000a2";
const UNDO_PATH = `/v1/chat/threads/${THREAD_ID}/messages/${MESSAGE_ID}/local-files/undo`;

/** The undo endpoint as a test sets it, and what reached it, in order. */
const server: {
  read: ChatLocalFilesUndoRead;
  answer: { status: number; body: ChatLocalFilesUndoAnswer };
  /** Every call the page made: `undo` for a request, `send` for an edit. */
  calls: ("undo" | "send")[];
  reads: number;
} = {
  read: {
    files: { type: "none" },
    conversation: { type: "continues" },
    undo: null,
  },
  answer: {
    status: 202,
    body: {
      status: "accepted",
      undo: {
        restoreId: "018f0000-0000-7000-8000-0000000000c1",
        state: "restored",
        reason: null,
      },
      reason: null,
    },
  },
  calls: [],
  reads: 0,
};

/** The undo request's answer when a test sets none: done at once. */
const RESTORED_ANSWER = server.answer;

const clients: InstanceType<typeof QueryClient>[] = [];
beforeEach(() => {
  server.read = {
    files: { type: "none" },
    conversation: { type: "continues" },
    undo: null,
  };
  server.answer = RESTORED_ANSWER;
  server.calls = [];
  server.reads = 0;
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : input.toString(),
        );
        const method = (
          init?.method ?? (input instanceof Request ? input.method : "GET")
        ).toUpperCase();
        if (url.pathname !== UNDO_PATH) {
          return Response.json({});
        }
        if (method === "POST") {
          server.calls.push("undo");
          return Response.json(server.answer.body, {
            status: server.answer.status,
          });
        }
        server.reads += 1;
        return Response.json(server.read);
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
});
afterEach(async () => {
  mock.restore();
  await act(async () => {
    cleanup();
    for (const client of clients) {
      client.clear();
    }
    clients.length = 0;
  });
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

type EditableUserMessageProps = Parameters<typeof EditableUserMessage>[0];
type UserMessageEditActions = NonNullable<EditableUserMessageProps["actions"]>;

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

/** Actions that record what the message asked for; the server accepts
 *  every edit. */
const createActions = () => {
  const started: true[] = [];
  /** Each sent edit: the message it replaces and what it carries. */
  const submitted: [string, UserMessageEdit][] = [];
  /** The edit sessions whose form holds the queue now. */
  const holding: string[] = [];
  const sessions = createUserMessageEditSessions(createUuid);
  const actions: UserMessageEditActions = {
    threadId: THREAD_ID,
    openSession: (messageId) => sessions.open(messageId),
    holdQueue: (sessionId) => {
      holding.push(sessionId);
      return () => {
        holding.splice(holding.indexOf(sessionId), 1);
      };
    },
    onStart: () => {
      started.push(true);
    },
    onSubmit: async (messageId, edit) => {
      submitted.push([messageId, edit]);
      server.calls.push("send");
      await Promise.resolve();
      return { type: "accepted" };
    },
  };
  return { actions, holding, started, submitted };
};

const renderMessage = ({
  actions,
  isGenerating = false,
  target = message,
}: {
  actions: UserMessageEditActions | undefined;
  isGenerating?: boolean;
  target?: EditableUserMessageProps["message"];
}) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <ChatThreadTestRouter>
        <IntlProvider locale="en" messages={en} timeZone="UTC">
          <AuthenticatedUserProvider
            user={{
              activeOrganizationId: "018f0000-0000-7000-8000-0000000000b1",
              email: "member@example.test",
              id: "018f0000-0000-7000-8000-0000000000b2",
              image: null,
              name: "Member",
              preferredName: null,
              timezoneId: "UTC",
              wordEditShortcut: null,
            }}
          >
            <TooltipProvider>
              <EditableUserMessage
                actions={actions}
                isGenerating={isGenerating}
                message={target}
              >
                <p>{SENT_BODY}</p>
              </EditableUserMessage>
            </TooltipProvider>
          </AuthenticatedUserProvider>
        </IntlProvider>
      </ChatThreadTestRouter>
    </QueryClientProvider>,
  );
};

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

  test("send writes the composer's markup and the kept attachments", async () => {
    const { actions, holding, submitted } = createActions();
    const view = renderMessage({ actions });

    openEditor(view);
    expect(holding).toHaveLength(1);
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
    // Once the server accepted it, the form closes and releases the queue;
    // the sent copy takes the message's place.
    await waitFor(() => {
      expect(
        view.queryByRole("textbox", { name: en.chat.editMessageInput }) ===
          null,
      ).toBe(true);
    });
    // The closed form's effects run once React flushes them.
    await act(async () => {
      await Promise.resolve();
    });
    expect(holding).toEqual([]);
  });

  describe("while a sent edit waits for the server", () => {
    /** Sends the edit through actions the test answers itself, and checks
     *  that the draft cannot change while the answer is out. */
    const sendAndWait = async (outcome: UserMessageEditOutcome) => {
      const { actions, submitted } = createActions();
      const answered = Promise.withResolvers<undefined>();
      const view = renderMessage({
        actions: {
          ...actions,
          onSubmit: async (...call) => {
            await actions.onSubmit(...call);
            await answered.promise;
            return outcome;
          },
        },
      });
      const field = openEditor(view);
      fireEvent.click(view.getByRole("button", { name: en.chat.sendPrompt }));

      await waitFor(() => {
        expect(field.getAttribute("contenteditable")).toBe("false");
      });
      fireEvent.paste(field, { clipboardData: plainTextClipboard(" more") });
      fireEvent.keyDown(field, { key: "Enter" });
      expect(field.textContent).toBe("Review the draft NDA");
      expect(view.queryByRole("button", { name: REMOVE_NDA }) === null).toBe(
        true,
      );
      const send = view.getByRole("button", { name: en.chat.sendPrompt });
      expect(
        send.hasAttribute("disabled") ||
          send.getAttribute("aria-disabled") === "true",
      ).toBe(true);
      expect(submitted).toHaveLength(1);

      await act(async () => {
        answered.resolve(undefined);
        await answered.promise;
      });
      return { field, submitted, view };
    };

    test("an accepted answer closes the form on the draft that was sent", async () => {
      const { submitted, view } = await sendAndWait({ type: "accepted" });

      await waitFor(() => {
        expect(
          view.queryByRole("textbox", { name: en.chat.editMessageInput }) ===
            null,
        ).toBe(true);
      });
      expect(submitted.map(([, edit]) => edit)).toEqual([
        {
          attachments: [ndaDocument],
          html: "<p>Review the <strong>draft</strong> NDA</p>",
        },
      ]);
    });

    test("a refusal hands the draft back, editable and intact", async () => {
      const { field, view } = await sendAndWait({
        code: CHAT_MESSAGE_EDIT_ERROR_CODE.turnRunning,
        type: "edit-refused",
      });

      await waitFor(() => {
        expect(field.getAttribute("contenteditable")).toBe("true");
      });
      expect(field.textContent).toBe("Review the draft NDA");
      expect(view.getByRole("button", { name: REMOVE_NDA })).toBeDefined();
      fireEvent.paste(field, { clipboardData: plainTextClipboard(" again") });
      expect(field.textContent).toBe("Review the draft NDA again");
    });
  });

  test("a refused edit keeps the form open on the draft and says why", async () => {
    const { actions, submitted } = createActions();
    const refusing: UserMessageEditActions = {
      ...actions,
      onSubmit: async (...call) => {
        await actions.onSubmit(...call);
        return {
          type: "edit-refused",
          code: CHAT_MESSAGE_EDIT_ERROR_CODE.historyChanged,
        };
      },
    };
    const view = renderMessage({ actions: refusing });

    fireEvent.paste(openEditor(view), {
      clipboardData: plainTextClipboard(" today"),
    });
    fireEvent.click(view.getByRole("button", { name: REMOVE_NDA }));
    fireEvent.click(view.getByRole("button", { name: en.chat.sendPrompt }));

    expect((await view.findByRole("alert")).textContent).toBe(
      en.chat.editMessageRefusedHistoryChanged,
    );
    const field = view.getByRole("textbox", { name: en.chat.editMessageInput });
    expect(field.textContent).toBe("Review the draft NDA today");
    expect(view.queryByRole("button", { name: REMOVE_NDA })).toBeNull();
    // The same draft can be sent again.
    fireEvent.click(view.getByRole("button", { name: en.chat.sendPrompt }));
    expect(submitted.map(([, edit]) => edit)).toEqual([
      {
        attachments: [],
        html: "<p>Review the <strong>draft</strong> NDA today</p>",
      },
      {
        attachments: [],
        html: "<p>Review the <strong>draft</strong> NDA today</p>",
      },
    ]);
  });

  test("an open form holds the queue until it closes", () => {
    const { actions, holding } = createActions();
    const view = renderMessage({ actions });

    openEditor(view);
    expect(holding).toHaveLength(1);
    fireEvent.click(view.getByRole("button", { name: en.common.cancel }));
    expect(holding).toEqual([]);
  });

  test("a changed edit is unsaved work until the form closes", async () => {
    const { actions } = createActions();
    const view = renderMessage({ actions });

    const field = openEditor(view);
    expect(hasUnsavedWork()).toBe(false);
    fireEvent.paste(field, {
      clipboardData: plainTextClipboard(" today"),
    });
    await waitFor(() => {
      expect(hasUnsavedWork()).toBe(true);
    });
    fireEvent.click(view.getByRole("button", { name: en.common.cancel }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(hasUnsavedWork()).toBe(false);
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

  test("an edit whose text looks like a credential is held, as a new message is", () => {
    const warning = spyOn(stellaToast, "warning").mockReturnValue("held");
    const { actions, submitted } = createActions();
    const view = renderMessage({
      actions,
      target: {
        id: MESSAGE_ID,
        parts: [{ type: "text", content: `Use sk-${"a".repeat(32)}` }],
        role: "user",
      },
    });

    fireEvent.keyDown(openEditor(view), { key: "Enter" });

    expect(submitted).toEqual([]);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      en.chat.credentialSendTitle,
      expect.anything(),
    );
    expect(
      view.getByRole("textbox", { name: en.chat.editMessageInput }),
    ).toBeDefined();
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

/** A clipboard holding plain text, as a browser hands it to a paste. */
const plainTextClipboard = (text: string) => ({
  getData: (type: string) => (type === "text/plain" ? text : ""),
  items: [],
  types: ["text/plain"],
});

describe("pasting into the edit form", () => {
  // A message with no text, so the paste is all the edit holds.
  const attachmentOnly: EditableUserMessageProps["message"] = {
    id: MESSAGE_ID,
    parts: [ndaDocument],
    role: "user",
  };

  test("pasted lines stay lines through the request and the stored Markdown", () => {
    const { actions, submitted } = createActions();
    const view = renderMessage({ actions, target: attachmentOnly });

    fireEvent.paste(openEditor(view), {
      clipboardData: plainTextClipboard("First\nSecond"),
    });
    fireEvent.click(view.getByRole("button", { name: en.chat.sendPrompt }));

    const edit = submitted.at(0)?.[1];
    expect(edit?.html).toBe("<p>First<br>Second</p>");
    // What the server stores for it: the two lines, a line break between.
    expect(htmlToMarkdown(edit?.html ?? "")).toBe("First  \nSecond\n");
  });

  test("a long paste travels as a pasted-text attachment, as from the composer", () => {
    const { actions, submitted } = createActions();
    const view = renderMessage({ actions, target: attachmentOnly });
    const long = Array.from(
      { length: PASTED_TEXT_CHIP_MAX_LINES + 1 },
      (_, line) => `Clause ${String(line + 1)}`,
    ).join("\n");

    fireEvent.paste(openEditor(view), {
      clipboardData: plainTextClipboard(long),
    });
    fireEvent.click(view.getByRole("button", { name: en.chat.sendPrompt }));

    expect(submitted.at(0)?.[1]).toEqual({
      attachments: [ndaDocument, createChatPastedTextPart(long)],
      html: "",
    });
  });
});

const UNDO_FILES = en.chat.localFilesUndo.option;

/** The read of a chat whose turns since the message worked in a folder. */
const localRead = (
  files: ChatLocalFilesUndoRead["files"],
): ChatLocalFilesUndoRead => ({
  files,
  conversation: { type: "continues" },
  undo: null,
});

/** Click the box's label, as a member does; it answers once React flushed. */
const toggle = async (box: HTMLElement) => {
  await act(async () => {
    fireEvent.click(box.closest("label") ?? box);
    await Promise.resolve();
  });
};

const isDisabled = (control: HTMLElement) =>
  control.hasAttribute("disabled") ||
  Object.hasOwn(control.dataset, "disabled") ||
  control.getAttribute("aria-disabled") === "true";

describe("undoing the file changes made since the message", () => {
  test("a chat whose turns touched no folder offers no file choice", async () => {
    const { actions } = createActions();
    const view = renderMessage({ actions });

    openEditor(view);
    await waitFor(() => {
      expect(server.reads).toBe(1);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(view.queryByRole("checkbox")).toBeNull();
    expect(
      view.queryByText(en.chat.localFilesUndo.conversationRestarts),
    ).toBeNull();
  });

  test("a local chat offers the box unchecked with its hint, and a send without it sends the edit alone", async () => {
    server.read = localRead({ type: "available" });
    const { actions } = createActions();
    const view = renderMessage({ actions });

    openEditor(view);
    const box = await view.findByRole("checkbox", { name: UNDO_FILES });

    expect(box.getAttribute("aria-checked")).toBe("false");
    expect(isDisabled(box)).toBe(false);
    expect(view.getByText(en.chat.localFilesUndo.optionHint)).toBeDefined();
    fireEvent.click(view.getByRole("button", { name: en.chat.sendPrompt }));
    await waitFor(() => {
      expect(server.calls).toEqual(["send"]);
    });
  });

  test("changes that cannot be undone show the box disabled with why, and the edit alone is sent", async () => {
    server.read = localRead({ type: "unavailable", reason: "several_folders" });
    const { actions } = createActions();
    const view = renderMessage({ actions });

    openEditor(view);
    const box = await view.findByRole("checkbox", { name: UNDO_FILES });

    expect(isDisabled(box)).toBe(true);
    expect(
      view.getByText(en.chat.localFilesUndo.refused.severalFolders),
    ).toBeDefined();
    await toggle(box);
    expect(box.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(view.getByRole("button", { name: en.chat.sendPrompt }));
    await waitFor(() => {
      expect(server.calls).toEqual(["send"]);
    });
  });

  test("with the box checked the folder is restored first, then the edit is sent", async () => {
    server.read = localRead({ type: "available" });
    const { actions, submitted } = createActions();
    const view = renderMessage({ actions });

    openEditor(view);
    const box = await view.findByRole("checkbox", { name: UNDO_FILES });
    await toggle(box);
    expect(box.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(view.getByRole("button", { name: en.chat.sendPrompt }));

    await waitFor(() => {
      expect(server.calls).toEqual(["undo", "send"]);
    });
    expect(submitted.map(([messageId]) => messageId)).toEqual([MESSAGE_ID]);
  });

  test("a refused undo sends nothing, keeps the draft and says why, the box unchecked", async () => {
    server.read = localRead({ type: "available" });
    server.answer = {
      status: 409,
      body: { status: "refused", undo: null, reason: "desktop_offline" },
    };
    const { actions, submitted } = createActions();
    const view = renderMessage({ actions });

    const field = openEditor(view);
    fireEvent.paste(field, { clipboardData: plainTextClipboard(" today") });
    await toggle(await view.findByRole("checkbox", { name: UNDO_FILES }));
    fireEvent.click(view.getByRole("button", { name: en.chat.sendPrompt }));

    expect((await view.findByRole("alert")).textContent).toBe(
      en.chat.localFilesUndo.refused.desktopOffline,
    );
    expect(server.calls).toEqual(["undo"]);
    expect(submitted).toEqual([]);
    await waitFor(() => {
      expect(field.getAttribute("contenteditable")).toBe("true");
    });
    expect(field.textContent).toBe("Review the draft NDA today");
    expect(
      view
        .getByRole("checkbox", { name: UNDO_FILES })
        .getAttribute("aria-checked"),
    ).toBe("false");
    // Sending again sends the edit alone.
    fireEvent.click(view.getByRole("button", { name: en.chat.sendPrompt }));
    await waitFor(() => {
      expect(server.calls).toEqual(["undo", "send"]);
    });
  });

  test("changes an earlier undo restored are shown as undone, and a send sends only the edit", async () => {
    server.read = {
      ...localRead({ type: "available" }),
      undo: {
        restoreId: "018f0000-0000-7000-8000-0000000000c1",
        state: "restored",
        reason: null,
      },
    };
    const { actions } = createActions();
    const view = renderMessage({ actions });

    openEditor(view);
    expect(
      await view.findByText(en.chat.localFilesUndo.restored),
    ).toBeDefined();
    expect(view.queryByRole("checkbox")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: en.chat.sendPrompt }));
    await waitFor(() => {
      expect(server.calls).toEqual(["send"]);
    });
  });

  test("says the agent starts over when the reply before the message did not finish", async () => {
    server.read = {
      files: { type: "none" },
      conversation: { type: "restarts", reason: "previous_not_finished" },
      undo: null,
    };
    const { actions } = createActions();
    const view = renderMessage({ actions });

    openEditor(view);

    expect(
      await view.findByText(en.chat.localFilesUndo.conversationRestarts),
    ).toBeDefined();
  });
});
