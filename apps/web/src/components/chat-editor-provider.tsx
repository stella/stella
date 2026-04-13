import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import type React from "react";

import { useQueryClient } from "@tanstack/react-query";
import Document from "@tiptap/extension-document";
import History from "@tiptap/extension-history";
import Paragraph from "@tiptap/extension-paragraph";
import Placeholder from "@tiptap/extension-placeholder";
import Text from "@tiptap/extension-text";
import type { EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import type { Editor, JSONContent } from "@tiptap/react";
import { useEditor } from "@tiptap/react";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  ChatMention,
  createChatSuggestion,
} from "@/components/chat-mention-extension";
import type { ChatMentionOption } from "@/components/chat-mention-extension";
import { getMentionViewScope } from "@/components/chat-mention-helpers";
import {
  createChatDraftState,
  createEmptyChatDraftDoc,
  useChatDraftStore,
} from "@/lib/chat-draft-store";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { getChatThreadKey } from "@/lib/chat-thread-ref";
import { entitiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { viewsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/views";
import {
  getEntityName,
  getFirstFile,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";

const CHAT_FILES_PER_MESSAGE = 5;
const CHAT_MAX_FILE_BYTES = 10 * 1024 * 1024;

const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const TEXT_PLAIN_MIME_TYPE = "text/plain";
const TEXT_CSV_MIME_TYPE = "text/csv";
const TEXT_MARKDOWN_MIME_TYPE = "text/markdown";

const ALLOWED_CHAT_FILE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  DOCX_MIME_TYPE,
  TEXT_PLAIN_MIME_TYPE,
  TEXT_CSV_MIME_TYPE,
  TEXT_MARKDOWN_MIME_TYPE,
]);

export const CHAT_FILE_INPUT_ACCEPT =
  ".png,.jpg,.jpeg,.webp,.gif,.pdf,.docx,.txt,.csv,.md";
const EMPTY_ATTACHMENTS: ChatDraftAttachment[] = [];
const EMPTY_CHAT_DRAFT_DOC = createEmptyChatDraftDoc();

type ChatDraftAttachmentBase = {
  file: File;
  filename: string;
  id: string;
  mimeType: string;
};

export type ChatDraftAttachment = ChatDraftAttachmentBase;

export type ChatInputDraft = {
  files: ChatDraftAttachment[];
  html: string;
};

export type ChatInputMentionSource = {
  id: string;
  getItems: () => ChatMentionOption[];
};

export type ChatInputPluginRegistration = {
  key: string | PluginKey;
  plugin: Plugin;
};

export type ChatInputExtensionRegistration = {
  mentionSources?: ChatInputMentionSource[];
  plugins?: ChatInputPluginRegistration[];
};

type RegisteredExtension = {
  registration: ChatInputExtensionRegistration;
  token: symbol;
};

type ActiveChatEditorHandle = {
  focus: () => void;
  insertMention: (mention: ChatMentionOption) => void;
  threadKey: string;
};

export type ChatEditorController = {
  attachments: ChatDraftAttachment[];
  canSubmit: boolean;
  editor: Editor | null;
  fileInputAccept: string;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  focus: () => void;
  handleDragOver: (event: React.DragEvent) => void;
  handleDrop: (event: React.DragEvent) => void;
  handleFileInputChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  handlePaste: (event: React.ClipboardEvent) => void;
  isEmpty: boolean;
  openFilePicker: () => void;
  removeFile: (id: string) => void;
  setSubmitHandler: (handler: (() => Promise<void>) | null) => void;
  submit: (
    send: (draft: ChatInputDraft) => Promise<void> | void,
  ) => Promise<void>;
};

type ChatEditorManagerContextValue = {
  activeThreadKey: string | null;
  extensionVersion: number;
  focusThread: (threadRef: ChatThreadRef) => void;
  getMentionItems: () => ChatMentionOption[];
  getPluginRegistrations: () => ChatInputPluginRegistration[];
  insertMentionIntoThread: (
    threadRef: ChatThreadRef,
    mention: ChatMentionOption,
  ) => void;
  registerActiveEditor: (handle: ActiveChatEditorHandle) => () => void;
  registerExtension: (
    id: string,
    registration: ChatInputExtensionRegistration,
  ) => () => void;
};

const ChatEditorManagerContext =
  createContext<ChatEditorManagerContextValue | null>(null);

const isSuggestionPluginState = (
  value: unknown,
): value is { active: boolean } =>
  value !== null &&
  typeof value === "object" &&
  "active" in value &&
  typeof value.active === "boolean";

const isSuggestionPluginActive = (state: EditorState): boolean =>
  state.plugins.some((plugin) => {
    const pluginState: unknown = plugin.getState(state);
    return isSuggestionPluginState(pluginState) && pluginState.active;
  });

const areDocsEqual = (left: JSONContent, right: JSONContent) =>
  JSON.stringify(left) === JSON.stringify(right);

export const ChatEditorProvider = ({ children }: React.PropsWithChildren) => {
  const registrationsRef = useRef(new Map<string, RegisteredExtension>());
  const activeEditorRef = useRef<ActiveChatEditorHandle | null>(null);
  const [extensionVersion, setExtensionVersion] = useState(0);
  const [activeThreadKey, setActiveThreadKey] = useState<string | null>(null);

  const getMentionItems = useCallback(() => {
    const items: ChatMentionOption[] = [];

    for (const { registration } of registrationsRef.current.values()) {
      if (!registration.mentionSources) {
        continue;
      }

      for (const source of registration.mentionSources) {
        items.push(...source.getItems());
      }
    }

    return items;
  }, []);

  const getPluginRegistrations = useCallback(() => {
    const plugins: ChatInputPluginRegistration[] = [];

    for (const { registration } of registrationsRef.current.values()) {
      if (!registration.plugins) {
        continue;
      }

      plugins.push(...registration.plugins);
    }

    return plugins;
  }, []);

  const registerExtension = useCallback(
    (id: string, registration: ChatInputExtensionRegistration) => {
      const token = Symbol(id);
      registrationsRef.current.set(id, {
        registration,
        token,
      });
      setExtensionVersion((value) => value + 1);

      return () => {
        const current = registrationsRef.current.get(id);
        if (current === undefined || current.token !== token) {
          return;
        }

        registrationsRef.current.delete(id);
        setExtensionVersion((value) => value + 1);
      };
    },
    [],
  );

  const registerActiveEditor = useCallback((handle: ActiveChatEditorHandle) => {
    activeEditorRef.current = handle;
    setActiveThreadKey(handle.threadKey);

    return () => {
      if (activeEditorRef.current?.threadKey !== handle.threadKey) {
        return;
      }

      activeEditorRef.current = null;
      setActiveThreadKey((current) =>
        current === handle.threadKey ? null : current,
      );
    };
  }, []);

  const insertMentionIntoThread = useCallback(
    (threadRef: ChatThreadRef, mention: ChatMentionOption) => {
      const threadKey = getChatThreadKey(threadRef);
      const activeEditor = activeEditorRef.current;

      if (activeEditor?.threadKey === threadKey) {
        activeEditor.insertMention(mention);
        return;
      }

      useChatDraftStore.getState().insertMention(threadKey, mention);
    },
    [],
  );

  const focusThread = useCallback((threadRef: ChatThreadRef) => {
    const threadKey = getChatThreadKey(threadRef);
    const activeEditor = activeEditorRef.current;

    if (activeEditor?.threadKey !== threadKey) {
      return;
    }

    activeEditor.focus();
  }, []);

  const contextValue = useMemo<ChatEditorManagerContextValue>(
    () => ({
      activeThreadKey,
      extensionVersion,
      focusThread,
      getMentionItems,
      getPluginRegistrations,
      insertMentionIntoThread,
      registerActiveEditor,
      registerExtension,
    }),
    [
      activeThreadKey,
      extensionVersion,
      focusThread,
      getMentionItems,
      getPluginRegistrations,
      insertMentionIntoThread,
      registerActiveEditor,
      registerExtension,
    ],
  );

  return (
    <ChatEditorManagerContext.Provider value={contextValue}>
      {children}
    </ChatEditorManagerContext.Provider>
  );
};

export const useChatEditorExtensions = () => {
  const context = useContext(ChatEditorManagerContext);

  if (context === null) {
    panic("useChatEditorExtensions must be used within ChatEditorProvider");
  }

  return {
    registerExtension: context.registerExtension,
  };
};

export const useChatEditorManager = () => {
  const context = useContext(ChatEditorManagerContext);

  if (context === null) {
    panic("useChatEditorManager must be used within ChatEditorProvider");
  }

  return context;
};

export const useChatEditor = ({
  onDraftStart,
  threadRef,
}: {
  onDraftStart?: (() => void) | undefined;
  threadRef: ChatThreadRef;
}): ChatEditorController => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const submitHandlerRef = useRef<(() => Promise<void>) | null>(null);
  const fileIdCounterRef = useRef(0);
  const activePluginKeysRef = useRef<(string | PluginKey)[]>([]);
  const isApplyingStoredDraftRef = useRef(false);
  const draftStartedThreadKeyRef = useRef<string | null>(null);
  const threadKey = getChatThreadKey(threadRef);
  const {
    extensionVersion,
    getMentionItems,
    getPluginRegistrations,
    registerActiveEditor,
  } = useChatEditorManager();
  const draft = useChatDraftStore(
    (state) => state.draftsByThreadKey[threadKey] ?? null,
  );
  const setDraft = useChatDraftStore((state) => state.setDraft);
  const clearDraft = useChatDraftStore((state) => state.clearDraft);
  const draftDoc = draft?.doc ?? EMPTY_CHAT_DRAFT_DOC;
  const attachments = draft?.attachments ?? EMPTY_ATTACHMENTS;
  const [isEmpty, setIsEmpty] = useState(() =>
    areDocsEqual(draftDoc, EMPTY_CHAT_DRAFT_DOC),
  );
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  const markDraftStarted = useCallback(() => {
    if (draftStartedThreadKeyRef.current === threadKey) {
      return;
    }

    draftStartedThreadKeyRef.current = threadKey;
    onDraftStart?.();
  }, [onDraftStart, threadKey]);

  const loadWorkspaceEntities = useCallback(
    async (workspace: ChatMentionOption) => {
      if (!workspace.sourceViewId) {
        return [];
      }

      const views = await queryClient.ensureQueryData(
        viewsOptions(workspace.id),
      );
      const activeView =
        views.find((view) => view.id === workspace.sourceViewId) ?? null;

      if (!activeView) {
        return [];
      }

      const { filters, sorts } = getMentionViewScope(activeView.layout);
      const data = await queryClient.ensureQueryData(
        entitiesOptions({
          workspaceId: workspace.id,
          filters,
          sorts,
          page: 1,
        }),
      );

      return data.entities.map((entity): ChatMentionOption => {
        const file = getFirstFile(entity);

        return {
          id: entity.entityId,
          label: getEntityName(entity),
          category: "entity",
          kind: entity.kind,
          mimeType: file?.mimeType ?? null,
          sourceWorkspaceId: workspace.id,
        };
      });
    },
    [queryClient],
  );

  const handleEditorUpdate = useEffectEvent((nextEditor: Editor) => {
    setIsEmpty(nextEditor.isEmpty);

    if (isApplyingStoredDraftRef.current) {
      return;
    }

    setDraft(
      threadKey,
      createChatDraftState({
        attachments: attachmentsRef.current,
        doc: nextEditor.getJSON(),
      }),
    );

    if (!nextEditor.isEmpty) {
      markDraftStarted();
    }
  });

  const editor = useEditor({
    autofocus: false,
    content: draftDoc,
    extensions: [
      Document,
      Paragraph,
      Text,
      Placeholder.configure({
        placeholder: t("chat.placeholder"),
      }),
      History,
      ChatMention.configure({
        suggestion: createChatSuggestion(
          getMentionItems,
          loadWorkspaceEntities,
        ),
        deleteTriggerWithBackspace: true,
      }),
    ],
    onCreate: ({ editor: nextEditor }) => {
      setIsEmpty(nextEditor.isEmpty);
    },
    onUpdate: ({ editor: nextEditor }) => {
      handleEditorUpdate(nextEditor);
    },
    editorProps: {
      attributes: {
        class:
          "field-sizing-content max-h-48 min-h-10 overflow-y-auto text-sm focus-visible:outline-none",
      },
      handleKeyDown: (view, event) => {
        if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
          return false;
        }

        if (isSuggestionPluginActive(view.state)) {
          return false;
        }

        event.preventDefault();
        void submitHandlerRef.current?.();
        return true;
      },
    },
  });

  const syncEditorPlugins = useCallback(
    (targetEditor: Editor) => {
      const nextPlugins = getPluginRegistrations();

      if (activePluginKeysRef.current.length > 0) {
        targetEditor.unregisterPlugin(activePluginKeysRef.current);
      }

      for (const plugin of nextPlugins) {
        targetEditor.registerPlugin(plugin.plugin);
      }

      activePluginKeysRef.current = nextPlugins.map((plugin) => plugin.key);
    },
    [getPluginRegistrations],
  );

  useEffect(() => {
    if (editor === null) {
      return;
    }

    syncEditorPlugins(editor);

    return () => {
      if (activePluginKeysRef.current.length === 0) {
        return;
      }

      editor.unregisterPlugin(activePluginKeysRef.current);
      activePluginKeysRef.current = [];
    };
  }, [editor, extensionVersion, syncEditorPlugins]);

  useEffect(() => {
    if (editor === null) {
      return;
    }

    if (areDocsEqual(editor.getJSON(), draftDoc)) {
      setIsEmpty(editor.isEmpty);
      return;
    }

    isApplyingStoredDraftRef.current = true;
    editor.commands.setContent(draftDoc);
    isApplyingStoredDraftRef.current = false;
    setIsEmpty(editor.isEmpty);
  }, [draftDoc, editor]);

  const focus = useCallback(() => {
    if (editor === null) {
      return;
    }

    editor.commands.focus("end");
  }, [editor]);

  const insertMention = useCallback(
    (mention: ChatMentionOption) => {
      if (editor === null) {
        return;
      }

      markDraftStarted();
      editor
        .chain()
        .focus()
        .insertContent({
          type: "mention",
          attrs: {
            id: mention.id,
            label: mention.label,
            category: mention.category,
            kind: mention.kind,
            mimeType: mention.mimeType,
            sourceWorkspaceId: mention.sourceWorkspaceId,
          },
        })
        .insertContent(" ")
        .run();
    },
    [editor, markDraftStarted],
  );

  useEffect(() => {
    if (editor === null) {
      return;
    }

    return registerActiveEditor({
      focus,
      insertMention,
      threadKey,
    });
  }, [editor, focus, insertMention, registerActiveEditor, threadKey]);

  const updateAttachments = useCallback(
    (nextAttachments: ChatDraftAttachment[]) => {
      const doc = editor?.getJSON() ?? draftDoc;

      setDraft(
        threadKey,
        createChatDraftState({
          attachments: nextAttachments,
          doc,
        }),
      );

      if (nextAttachments.length > 0) {
        markDraftStarted();
      }
    },
    [draftDoc, editor, markDraftStarted, setDraft, threadKey],
  );

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const nextAttachments = [...attachmentsRef.current];

      for (const file of Array.from(files)) {
        if (nextAttachments.length >= CHAT_FILES_PER_MESSAGE) {
          break;
        }

        if (
          !ALLOWED_CHAT_FILE_MIME_TYPES.has(file.type) ||
          file.size > CHAT_MAX_FILE_BYTES
        ) {
          continue;
        }

        fileIdCounterRef.current += 1;
        nextAttachments.push({
          file,
          filename: file.name,
          id: `chat-file-${fileIdCounterRef.current}`,
          mimeType: file.type,
        });
      }

      updateAttachments(nextAttachments);
    },
    [updateAttachments],
  );

  const removeFile = useCallback(
    (id: string) => {
      updateAttachments(
        attachmentsRef.current.filter((attachment) => attachment.id !== id),
      );
    },
    [updateAttachments],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      if (event.dataTransfer.files.length === 0) {
        return;
      }

      addFiles(event.dataTransfer.files);
    },
    [addFiles],
  );

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
  }, []);

  const handlePaste = useCallback(
    (event: React.ClipboardEvent) => {
      const files: File[] = [];

      for (const item of event.clipboardData.items) {
        if (item.kind !== "file") {
          continue;
        }

        const file = item.getAsFile();
        if (file !== null) {
          files.push(file);
        }
      }

      if (files.length === 0) {
        return;
      }

      event.preventDefault();
      addFiles(files);
    },
    [addFiles],
  );

  const handleFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const { files } = event.target;
      if (files !== null && files.length > 0) {
        addFiles(files);
      }

      event.target.value = "";
    },
    [addFiles],
  );

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const submit = useCallback(
    async (send: (draft: ChatInputDraft) => Promise<void> | void) => {
      if (editor === null) {
        return;
      }

      const html = editor.isEmpty ? "" : editor.getHTML().trim();
      const doc = editor.getJSON();
      const files = attachmentsRef.current;

      if (!html && files.length === 0) {
        return;
      }

      clearDraft(threadKey);
      editor.commands.clearContent();
      setIsEmpty(true);
      draftStartedThreadKeyRef.current = null;

      try {
        await send({ files, html });
      } catch (error) {
        setDraft(
          threadKey,
          createChatDraftState({
            attachments: files,
            doc,
          }),
        );
        isApplyingStoredDraftRef.current = true;
        editor.commands.setContent(doc);
        isApplyingStoredDraftRef.current = false;
        setIsEmpty(editor.isEmpty);
        if (!editor.isEmpty || files.length > 0) {
          draftStartedThreadKeyRef.current = threadKey;
        }
        throw error;
      }
    },
    [clearDraft, editor, setDraft, threadKey],
  );

  const canSubmit = !isEmpty || attachments.length > 0;

  const setSubmitHandler = useCallback(
    (handler: (() => Promise<void>) | null) => {
      submitHandlerRef.current = handler;
    },
    [],
  );

  return {
    attachments,
    canSubmit,
    editor,
    fileInputAccept: CHAT_FILE_INPUT_ACCEPT,
    fileInputRef,
    focus,
    handleDragOver,
    handleDrop,
    handleFileInputChange,
    handlePaste,
    isEmpty,
    openFilePicker,
    removeFile,
    setSubmitHandler,
    submit,
  };
};
