import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

import type { DocxComments, DocxEditorRef } from "./app-docx-editor";

GlobalRegistrator.register({ url: "http://localhost:3000/document" });

const { act, cleanup, render, waitFor } =
  await import("@testing-library/react");
const React = await import("react");
const { IntlProvider } = await import("use-intl");
const { createEditorRefBridge, executeFolioToolCall, FOLIO_AGENT_TOOL_NAMES } =
  await import("@stll/folio-agents");
const { createEmptyDocument } = await import("@stll/folio-react");
const { createDocx, parseDocx } = await import("@stll/folio-core/server");
const { DocxEditor } = await import("./app-docx-editor");
const { useDocxComments } = await import("./use-docx-comments");
const { releaseUserStorage } =
  await import("@/lib/account/user-scoped-storage");
const { bundledEnglishMessages } = await import("@/i18n/i18n-store");

afterEach(() => {
  cleanup();
  releaseUserStorage();
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

test("published editor echoes agent comments and saves applied operations for reopen", async () => {
  const editorRef = React.createRef<DocxEditorRef>();
  const document = await parseDocx(
    await createDocx(createEmptyDocument({ initialText: "Seed paragraph." })),
  );
  const hostRef = React.createRef<{
    getComments: () => DocxComments;
    setComments: (comments: DocxComments) => void;
  }>();
  const onChange = () => {};
  const editorErrors: Error[] = [];
  const onError = (error: Error) => {
    editorErrors.push(error);
  };
  const getHostedComments = () => {
    const host = hostRef.current;
    if (!host) {
      throw new Error("Comments host did not mount");
    }
    return host.getComments();
  };

  const Harness = () => {
    const {
      docxComments,
      handleAiDocxCommentsChange,
      handleEditorDocxCommentsChange,
    } = useDocxComments(onChange);
    React.useImperativeHandle(
      hostRef,
      () => ({
        getComments: () => docxComments,
        setComments: handleAiDocxCommentsChange,
      }),
      [docxComments, handleAiDocxCommentsChange],
    );
    return (
      <IntlProvider
        locale="en"
        messages={bundledEnglishMessages}
        timeZone="UTC"
      >
        <DocxEditor
          comments={docxComments}
          document={document}
          onCommentsChange={handleEditorDocxCommentsChange}
          onError={onError}
          ref={editorRef}
          showOutline={false}
          showToolbar={false}
        />
      </IntlProvider>
    );
  };

  render(<Harness />);
  await waitFor(() => expect(editorRef.current).not.toBeNull());
  const getEditor = () => {
    const editor = editorRef.current;
    if (!editor) {
      throw new Error("Published editor ref did not mount");
    }
    return editor;
  };
  await act(async () => {
    getEditor().ensureEditorView({ focus: false });
  });
  await waitFor(() =>
    expect(getEditor().createAIEditSnapshot()).not.toBeNull(),
  );

  const snapshot = getEditor().createAIEditSnapshot();
  if (!snapshot) {
    throw new Error("Published editor snapshot is unavailable");
  }
  const block = snapshot.blocks.at(0);
  if (!block) {
    throw new Error("Synthetic document has no editable block");
  }

  const bridge = createEditorRefBridge({
    ref: getEditor(),
    author: "Test author",
    getComments: getHostedComments,
    setComments: (nextComments) => {
      const host = hostRef.current;
      if (!host) {
        throw new Error("Comments host did not mount");
      }
      host.setComments(nextComments);
    },
  });

  let addedOk = false;
  await act(async () => {
    const added = executeFolioToolCall(
      FOLIO_AGENT_TOOL_NAMES.addComment,
      { blockId: block.id, text: "Review this paragraph" },
      bridge,
    );
    addedOk = added.ok;
  });
  expect(addedOk).toBe(true);
  await waitFor(() => expect(getHostedComments()).toHaveLength(1));

  const comment = getHostedComments().at(0);
  if (!comment) {
    throw new Error("Agent comment did not reach host state");
  }
  await act(async () => {
    const replied = executeFolioToolCall(
      FOLIO_AGENT_TOOL_NAMES.replyComment,
      { commentId: String(comment.id), text: "I agree" },
      bridge,
    );
    expect(replied.ok).toBe(true);
  });
  await waitFor(() =>
    expect(
      getHostedComments().filter((reply) => reply.parentId === comment.id),
    ).toHaveLength(1),
  );
  await act(async () => {
    const resolved = executeFolioToolCall(
      FOLIO_AGENT_TOOL_NAMES.resolveComment,
      { commentId: String(comment.id) },
      bridge,
    );
    expect(resolved.ok).toBe(true);
  });
  await waitFor(() =>
    expect(
      getHostedComments().find((entry) => entry.id === comment.id)?.done,
    ).toBe(true),
  );

  const operationSnapshot = getEditor().createAIEditSnapshot();
  if (!operationSnapshot) {
    throw new Error("Operation snapshot is unavailable");
  }
  const operationBlock = operationSnapshot.blocks.at(0);
  if (!operationBlock) {
    throw new Error("Operation target block is unavailable");
  }
  const applied = await act(async () =>
    getEditor().applyDocumentOperations({
      snapshot: operationSnapshot,
      batch: {
        version: 1,
        mode: "direct",
        operations: [
          {
            id: "release-smoke-replace",
            type: "replaceBlock",
            blockId: operationBlock.id,
            text: "Published operation saved",
          },
        ],
      },
    }),
  );
  expect(applied.status).toBe("committed");
  expect(applied.undoHandle).not.toBeNull();
  const savedBuffer = await act(async () => getEditor().save());
  expect(editorErrors).toEqual([]);
  expect(savedBuffer).toBeInstanceOf(ArrayBuffer);
  if (!savedBuffer) {
    throw new Error("Published editor did not save a buffer");
  }

  await act(async () => getEditor().loadDocumentBuffer(savedBuffer));
  await waitFor(() =>
    expect(getEditor().createAIEditSnapshot()?.blocks.at(0)?.text).toBe(
      "Published operation saved",
    ),
  );

  const undoSnapshot = getEditor().createAIEditSnapshot();
  if (!undoSnapshot) {
    throw new Error("Reopened editor snapshot is unavailable");
  }
  const undoBlock = undoSnapshot.blocks.at(0);
  if (!undoBlock) {
    throw new Error("Reopened operation target is unavailable");
  }
  const secondApply = await act(async () =>
    getEditor().applyDocumentOperations({
      snapshot: undoSnapshot,
      batch: {
        version: 1,
        mode: "direct",
        operations: [
          {
            id: "release-smoke-undo",
            type: "replaceBlock",
            blockId: undoBlock.id,
            text: "Temporary replacement",
          },
        ],
      },
    }),
  );
  expect(secondApply.status).toBe("committed");
  const undoHandle = secondApply.undoHandle;
  if (!undoHandle) {
    throw new Error("Committed operation has no undo handle");
  }
  let undoStatus = "";
  await act(async () => {
    undoStatus = getEditor().undoDocumentOperations(undoHandle).status;
  });
  expect(undoStatus).toBe("undone");
  await waitFor(() =>
    expect(getEditor().createAIEditSnapshot()?.blocks.at(0)?.text).toBe(
      "Published operation saved",
    ),
  );
});
