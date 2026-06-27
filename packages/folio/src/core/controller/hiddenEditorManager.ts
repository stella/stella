/**
 * Hidden-editor view lifecycle manager
 *
 * Framework-agnostic owner of the off-screen ProseMirror EditorView. Holds the
 * view plus the bookkeeping that decides when an incoming document is a truly
 * external change (vs. an internal edit echoed back through props), builds the
 * editor state and `editorProps`, and composes the slice-2a imperative API so
 * the API and the lifecycle share one view owner. The React adapter
 * (`HiddenProseMirror`) keeps the input refs and its effects (which decide
 * *when* to act) and drives this manager through the methods below.
 */

import { panic } from "better-result";
import type { EditorState, Plugin, Transaction } from "prosemirror-state";
import { EditorState as PMEditorState } from "prosemirror-state";
import type { DirectEditorProps } from "prosemirror-view";
import { EditorView } from "prosemirror-view";
import type * as YProseMirror from "y-prosemirror";
import type { Doc as YDoc, XmlFragment } from "yjs";
import type * as Yjs from "yjs";

import {
  recordHiddenEditorPhase,
  recordHiddenEditorStateCreate,
  type HiddenEditorStateReason,
} from "../layout-engine/layoutInstrumentation";
import { suppressHiddenEditorScrollToSelection } from "../paged-layout/hiddenEditorScroll";
import { isReadOnlyEditKey } from "../paged-layout/readOnlyEditAttempt";
import { toProseDoc, createEmptyDoc } from "../prosemirror/conversion";
import type { ExtensionManager } from "../prosemirror/extensions/ExtensionManager";
import { ensureParaIdsInState } from "../prosemirror/extensions/features/ParaIdAllocatorExtension";
import { createDocumentStylesPlugin } from "../prosemirror/plugins/documentStyles";
import { schema } from "../prosemirror/schema";
import type { Document, StyleDefinitions } from "../types/document";
import { createHiddenEditorApi, type HiddenEditorApi } from "./hiddenEditorApi";

type YProseMirrorModule = typeof YProseMirror;
type YjsModule = typeof Yjs;

export type CollaborationModules = {
  yProseMirror: YProseMirrorModule;
  yjs: YjsModule;
};

type CollaborationAwareness = {
  clientID: number;
  getStates: () => Map<number, unknown>;
  off: (event: "change" | "update", handler: () => void) => void;
  on: (event: "change" | "update", handler: () => void) => void;
};

export type HiddenProseMirrorCollaboration = {
  awareness?: CollaborationAwareness | undefined;
  onSeeded?: (() => void) | undefined;
  shouldSeed?: boolean | undefined;
  yXmlFragment: XmlFragment;
};

export type HiddenProseMirrorRemoteSelection = {
  anchor: number;
  clientId: number;
  color: string;
  head: number;
  name: string;
};

type YSyncState = {
  binding: {
    mapping: Parameters<
      YProseMirrorModule["relativePositionToAbsolutePosition"]
    >[3];
  };
  doc: YDoc;
  type: XmlFragment;
};

type AwarenessCursor = {
  anchor: Record<string, unknown>;
  head: Record<string, unknown>;
};

type AwarenessUser = {
  color: string;
  name: string;
};

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isYSyncState = (value: unknown, yjs: YjsModule): value is YSyncState => {
  if (!isObjectRecord(value)) {
    return false;
  }
  const binding = value["binding"];
  return (
    value["doc"] instanceof yjs.Doc &&
    value["type"] instanceof yjs.XmlFragment &&
    isObjectRecord(binding) &&
    binding["mapping"] instanceof Map
  );
};

const readAwarenessCursor = (state: unknown): AwarenessCursor | null => {
  if (!isObjectRecord(state)) {
    return null;
  }
  const cursor = state["cursor"];
  if (!isObjectRecord(cursor)) {
    return null;
  }
  const anchor = cursor["anchor"];
  const head = cursor["head"];
  if (!isObjectRecord(anchor) || !isObjectRecord(head)) {
    return null;
  }
  return { anchor, head };
};

const readAwarenessUser = (state: unknown, clientId: number): AwarenessUser => {
  if (!isObjectRecord(state) || !isObjectRecord(state["user"])) {
    return {
      color: "var(--doc-image-selection)",
      name: `User ${clientId}`,
    };
  }

  const user = state["user"];
  return {
    color:
      typeof user["color"] === "string"
        ? user["color"]
        : "var(--doc-image-selection)",
    name: typeof user["name"] === "string" ? user["name"] : `User ${clientId}`,
  };
};

export const collectRemoteSelections = (
  state: EditorState,
  awareness: CollaborationAwareness,
  collaborationModules: CollaborationModules,
): HiddenProseMirrorRemoteSelection[] => {
  const syncState: unknown =
    collaborationModules.yProseMirror.ySyncPluginKey.getState(state);
  if (!isYSyncState(syncState, collaborationModules.yjs)) {
    return [];
  }

  const selections: HiddenProseMirrorRemoteSelection[] = [];
  for (const [clientId, remoteState] of awareness.getStates()) {
    if (clientId === awareness.clientID) {
      continue;
    }

    const cursor = readAwarenessCursor(remoteState);
    if (cursor === null) {
      continue;
    }

    const anchor =
      collaborationModules.yProseMirror.relativePositionToAbsolutePosition(
        syncState.doc,
        syncState.type,
        collaborationModules.yjs.createRelativePositionFromJSON(cursor.anchor),
        syncState.binding.mapping,
      );
    const head =
      collaborationModules.yProseMirror.relativePositionToAbsolutePosition(
        syncState.doc,
        syncState.type,
        collaborationModules.yjs.createRelativePositionFromJSON(cursor.head),
        syncState.binding.mapping,
      );
    if (anchor === null || head === null) {
      continue;
    }

    const user = readAwarenessUser(remoteState, clientId);
    selections.push({
      anchor,
      clientId,
      color: user.color,
      head,
      name: user.name,
    });
  }

  return selections;
};

const HIDDEN_EDITOR_ATTRIBUTES = {
  "aria-label": "Document content",
  "aria-multiline": "true",
  autocapitalize: "off",
  autocomplete: "off",
  autocorrect: "off",
  role: "textbox",
  spellcheck: "false",
  translate: "no",
};

/**
 * Create ProseMirror state from document
 *
 * When an ExtensionManager is provided, it supplies the schema and plugins.
 * Otherwise falls back to the default singleton schema with no extension plugins.
 */
export type CreateHiddenEditorStateOptions = {
  document: Document | null;
  styles?: StyleDefinitions | null | undefined;
  manager?: ExtensionManager | undefined;
  externalPlugins?: Plugin[] | undefined;
  collaboration?: HiddenProseMirrorCollaboration | undefined;
  collaborationModules?: CollaborationModules | null | undefined;
  reason?: HiddenEditorStateReason | undefined;
};

export function createHiddenEditorState(
  options: CreateHiddenEditorStateOptions,
): EditorState {
  const {
    document,
    styles,
    manager,
    externalPlugins = [],
    collaboration,
    collaborationModules,
    reason = "mount",
  } = options;
  recordHiddenEditorStateCreate(reason);

  const activeSchema = manager?.getSchema() ?? schema;
  let localDoc = createEmptyDoc();
  if (document) {
    const startedAt = performance.now();
    localDoc =
      styles === undefined || styles === null
        ? toProseDoc(document)
        : toProseDoc(document, { styles });
    recordHiddenEditorPhase(
      reason,
      "to-prose-doc",
      performance.now() - startedAt,
    );
  }

  // Expose the document's styles to style-aware commands (e.g. the Enter
  // handler's `w:next` switch from heading to body text). Same resolver for
  // collab and non-collab paths.
  const styleResolverPlugin = createDocumentStylesPlugin(
    styles ?? document?.package.styles,
  );
  const plugins: Plugin[] = [
    ...externalPlugins,
    ...(manager?.getPlugins() ?? []),
    styleResolverPlugin,
  ];

  if (collaboration) {
    if (!collaborationModules) {
      panic(
        "Collaboration modules must be loaded before creating collaborative editor state.",
      );
    }

    if (collaboration.shouldSeed && collaboration.yXmlFragment.length === 0) {
      const seedState = ensureParaIdsInState(
        PMEditorState.create({
          doc: localDoc,
          schema: activeSchema,
          plugins,
        }),
      );
      collaborationModules.yProseMirror.prosemirrorToYXmlFragment(
        seedState.doc,
        collaboration.yXmlFragment,
      );
      collaboration.onSeeded?.();
    }

    let { doc } = collaborationModules.yProseMirror.initProseMirrorDoc(
      collaboration.yXmlFragment,
      activeSchema,
    );

    const initializedState = ensureParaIdsInState(
      PMEditorState.create({
        doc,
        schema: activeSchema,
        plugins,
      }),
    );
    if (!initializedState.doc.eq(doc)) {
      collaborationModules.yProseMirror.prosemirrorToYXmlFragment(
        initializedState.doc,
        collaboration.yXmlFragment,
      );
      ({ doc } = collaborationModules.yProseMirror.initProseMirrorDoc(
        collaboration.yXmlFragment,
        activeSchema,
      ));
    }

    const startedAt = performance.now();
    const state = ensureParaIdsInState(
      PMEditorState.create({
        doc,
        schema: activeSchema,
        plugins,
      }),
    );
    recordHiddenEditorPhase(
      reason,
      "editor-state",
      performance.now() - startedAt,
    );
    return state;
  }

  const startedAt = performance.now();
  const state = ensureParaIdsInState(
    PMEditorState.create({
      doc: localDoc,
      schema: activeSchema,
      plugins,
    }),
  );
  recordHiddenEditorPhase(
    reason,
    "editor-state",
    performance.now() - startedAt,
  );
  return state;
}

function getDocumentIdentity(doc: Document | null): string {
  if (!doc) {
    return "empty";
  }
  // Use the document's package id or a hash of its structure.
  // For simplicity, compare based on whether it has different metadata.
  const meta = doc.package.properties;
  const created = meta?.created ? String(meta.created) : "";
  const modified = meta?.modified ? String(meta.modified) : "";
  const title = meta?.title ?? "";
  return `${created}-${modified}-${title}`;
}

function syncHiddenEditorAccessibility(
  view: EditorView,
  readOnly: boolean,
): void {
  const { dom } = view;
  if (!dom.hasAttribute("tabindex")) {
    dom.tabIndex = 0;
  }
  dom.setAttribute("aria-readonly", readOnly ? "true" : "false");
}

export type HiddenEditorManagerDeps = {
  getHost: () => HTMLElement | null;
  getDocument: () => Document | null;
  getStyles: () => StyleDefinitions | null | undefined;
  getExtensionManager: () => ExtensionManager | undefined;
  getExternalPlugins: () => Plugin[];
  getCollaboration: () => HiddenProseMirrorCollaboration | undefined;
  getCollaborationModules: () => CollaborationModules | null;
  getPrecomputedInitialState: () => EditorState | null | undefined;
  getReadOnly: () => boolean;
  /**
   * Caller-provided stable identity of the loaded document: the same key across
   * internal edits (so typing does not trigger an external re-sync) and a
   * distinct key per loaded file. Authoritative when present; a metadata
   * signature is used as a fallback when undefined.
   */
  getDocumentKey: () => string | undefined;
  /** Document context for the API's `getDocument` (PM state -> Document). */
  getDocumentContext: () => Document | null;
  onTransaction: (transaction: Transaction, newState: EditorState) => void;
  onSelectionChange: (state: EditorState) => void;
  onKeyDown: (view: EditorView, event: KeyboardEvent) => boolean;
  onReadOnlyEditAttempt: () => void;
  onEditorViewReady: (view: EditorView) => void;
  onEditorViewDestroy: () => void;
  onRemoteSelectionsChange: (
    selections: HiddenProseMirrorRemoteSelection[],
  ) => void;
};

export type HiddenEditorManager = {
  /** Request the view (sets the requested flag, then attempts creation). */
  ensureView: () => void;
  /** Re-attempt a previously-requested-but-deferred creation (no-op otherwise). */
  retryViewCreation: () => void;
  isViewRequested: () => boolean;
  destroyView: () => void;
  syncExternalDocument: () => void;
  syncEditable: () => void;
  getView: () => EditorView | null;
  isInitialized: () => boolean;
  api: HiddenEditorApi;
};

export const createHiddenEditorManager = (
  deps: HiddenEditorManagerDeps,
): HiddenEditorManager => {
  let view: EditorView | null = null;
  let isDestroying = false;
  // The React adapter requests the view explicitly (first interaction) or
  // eagerly (collaboration); creation only proceeds once requested.
  let requested = false;
  // Track if we've initialized - first render needs to set up state.
  let isInitialized = false;
  // Track the document identity to detect truly external changes vs changes
  // that originated from editing (which get passed back through props).
  let lastDocumentId: string | null = null;
  let lastCollaborationFragment: XmlFragment | null = null;

  // A caller-provided documentKey is authoritative (stable across internal
  // edits, distinct per loaded file); fall back to a metadata signature when no
  // key is supplied.
  const currentDocumentIdentity = (): string =>
    deps.getDocumentKey() ?? getDocumentIdentity(deps.getDocument());

  const tryCreate = (): void => {
    if (!requested || view !== null || isDestroying) {
      return;
    }
    const host = deps.getHost();
    if (!host) {
      return;
    }
    const collaboration = deps.getCollaboration();
    const collaborationModules = deps.getCollaborationModules();
    if (collaboration && !collaborationModules) {
      return;
    }

    const precomputedInitialState = deps.getPrecomputedInitialState();
    const document = deps.getDocument();
    const styles = deps.getStyles();
    const extensionManager = deps.getExtensionManager();
    const externalPlugins = deps.getExternalPlugins();

    const initialState =
      precomputedInitialState && !collaboration
        ? precomputedInitialState
        : createHiddenEditorState({
            document,
            styles,
            manager: extensionManager,
            externalPlugins,
            collaboration,
            collaborationModules,
            reason: "mount",
          });

    const editorProps: DirectEditorProps = {
      state: initialState,
      attributes: HIDDEN_EDITOR_ATTRIBUTES,
      editable: () => !deps.getReadOnly(),
      dispatchTransaction: (transaction: Transaction) => {
        if (!view || isDestroying) {
          return;
        }

        if (deps.getReadOnly() && transaction.docChanged) {
          deps.onReadOnlyEditAttempt();
          return;
        }

        const newState = view.state.apply(transaction);
        view.updateState(newState);

        // Notify about transaction.
        deps.onTransaction(transaction, newState);

        // Notify about selection changes.
        if (transaction.selectionSet || transaction.docChanged) {
          deps.onSelectionChange(newState);
        }

        const currentCollaboration = deps.getCollaboration();
        const currentCollaborationModules = deps.getCollaborationModules();
        if (currentCollaboration?.awareness && currentCollaborationModules) {
          deps.onRemoteSelectionsChange(
            collectRemoteSelections(
              newState,
              currentCollaboration.awareness,
              currentCollaborationModules,
            ),
          );
        }
      },
      // Intercept key events before ProseMirror processes them
      handleKeyDown: (pmView: EditorView, event: KeyboardEvent): boolean => {
        if (deps.getReadOnly() && isReadOnlyEditKey(event)) {
          deps.onReadOnlyEditAttempt();
          event.preventDefault();
          return true;
        }

        return deps.onKeyDown(pmView, event);
      },
      handleScrollToSelection: suppressHiddenEditorScrollToSelection,
      // Prevent focus handling from interfering with visual layer
      handleDOMEvents: {
        focus: () => false,
        blur: () => false,
        beforeinput: (_view, event) => {
          if (!deps.getReadOnly()) {
            return false;
          }
          deps.onReadOnlyEditAttempt();
          event.preventDefault();
          return true;
        },
        paste: (_view, event) => {
          if (!deps.getReadOnly()) {
            return false;
          }
          deps.onReadOnlyEditAttempt();
          event.preventDefault();
          return true;
        },
        drop: (_view, event) => {
          if (!deps.getReadOnly()) {
            return false;
          }
          deps.onReadOnlyEditAttempt();
          event.preventDefault();
          return true;
        },
      },
    };

    const viewStartedAt = performance.now();
    view = new EditorView(host, editorProps);
    recordHiddenEditorPhase(
      "mount",
      "editor-view",
      performance.now() - viewStartedAt,
    );
    syncHiddenEditorAccessibility(view, deps.getReadOnly());
    isInitialized = true;
    lastDocumentId = currentDocumentIdentity();
    lastCollaborationFragment = collaboration?.yXmlFragment ?? null;

    // Notify that view is ready.
    deps.onEditorViewReady(view);
  };

  const ensureView = (): void => {
    requested = true;
    tryCreate();
  };

  // Completes a previously-requested creation once a gate clears (e.g. the
  // async collaboration modules finish loading); a no-op until requested.
  const retryViewCreation = (): void => {
    tryCreate();
  };

  const isViewRequested = (): boolean => requested;

  const destroyView = (): void => {
    if (view && !isDestroying) {
      isDestroying = true;

      deps.onEditorViewDestroy();

      view.destroy();
      view = null;
      isDestroying = false;
    }
  };

  // Update state when document changes externally (e.g., loading a new file).
  // This should NOT run when the document prop changes due to internal edits
  // being passed back through the parent component's state.
  const syncExternalDocument = (): void => {
    if (!view || isDestroying) {
      return;
    }
    const collaboration = deps.getCollaboration();
    const collaborationModules = deps.getCollaborationModules();
    if (collaboration && !collaborationModules) {
      return;
    }

    const document = deps.getDocument();
    const currentDocId = currentDocumentIdentity();
    const currentCollaborationFragment = collaboration?.yXmlFragment ?? null;
    const collaborationSourceChanged =
      currentCollaborationFragment !== lastCollaborationFragment;

    if (collaboration && !collaborationSourceChanged) {
      return;
    }

    // Skip if this is the same document (likely passed back after internal edit)
    // Only reset state if:
    // 1. Not yet initialized (first mount)
    // 2. Document identity changed (truly external change like loading a new file)
    // 3. Collaboration starts/stops or switches sessions
    if (
      isInitialized &&
      currentDocId === lastDocumentId &&
      !collaborationSourceChanged
    ) {
      return;
    }

    // Update tracking state
    isInitialized = true;
    lastDocumentId = currentDocId;
    lastCollaborationFragment = currentCollaborationFragment;

    // Create new state from document
    const newState = createHiddenEditorState({
      document,
      styles: deps.getStyles(),
      manager: deps.getExtensionManager(),
      externalPlugins: deps.getExternalPlugins(),
      collaboration,
      collaborationModules,
      reason: "external-document",
    });
    const updateStartedAt = performance.now();
    view.updateState(newState);
    recordHiddenEditorPhase(
      "external-document",
      "update-state",
      performance.now() - updateStartedAt,
    );
    syncHiddenEditorAccessibility(view, deps.getReadOnly());

    deps.onSelectionChange(newState);
  };

  const syncEditable = (): void => {
    if (!view) {
      return;
    }
    // EditorView calls editable() dynamically; ARIA state needs explicit sync.
    syncHiddenEditorAccessibility(view, deps.getReadOnly());
  };

  const api = createHiddenEditorApi({
    getView: () => view,
    getDocumentContext: deps.getDocumentContext,
    isDestroying: () => isDestroying,
    ensureView,
    isViewRequested,
  });

  return {
    ensureView,
    retryViewCreation,
    isViewRequested,
    destroyView,
    syncExternalDocument,
    syncEditable,
    getView: () => view,
    isInitialized: () => isInitialized,
    api,
  };
};
