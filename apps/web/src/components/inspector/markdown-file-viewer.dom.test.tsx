import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, jest, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import type { MarkdownHybridEditorHandle } from "@/components/markdown/markdown-hybrid-editor";
import englishMessages from "@/i18n/langs/en.json";
import { browserStorage } from "@/lib/account/browser-storage";

import type { FileTab } from "./inspector-store-types";

const localArea = () =>
  browserStorage("local") ?? panic("Test requires local browser storage");

const NativeBroadcastChannel = globalThis.BroadcastChannel;
GlobalRegistrator.register({ url: "http://localhost:3000" });
window.BroadcastChannel = NativeBroadcastChannel;
Object.defineProperty(window.navigator, "userAgent", {
  configurable: true,
  value: "Macintosh; Mac OS X",
});
// happy-dom omits the legacy browser commands the EditContext polyfill wraps.
Object.assign(document, {
  execCommand: () => false,
  queryCommandEnabled: () => false,
  queryCommandSupported: () => false,
  queryCommandState: () => false,
  queryCommandValue: () => "",
});
const React = await import("react");
const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider, useTranslations } = await import("use-intl");
const { useInspectorTabsStore } = await import("./inspector-tabs-store");
const originalFetch = globalThis.fetch;
const requests: {
  file: File;
  answer: ReturnType<typeof Promise.withResolvers<Response>>;
}[] = [];
let publishedText = "Server text";
let storageFails = false;
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/upload-version")) {
      if (!(init?.body instanceof FormData)) {
        throw new TypeError("Expected a version FormData body");
      }
      const file = init.body.get("file");
      if (!(file instanceof File)) {
        throw new TypeError("Expected a Markdown file");
      }
      const answer = Promise.withResolvers<Response>();
      requests.push({ file, answer });
      return await answer.promise;
    }
    if (url.includes("/rename")) {
      if (typeof init?.body !== "string") {
        throw new TypeError("Expected a rename JSON body");
      }
      const { name } = JSON.parse(init.body);
      return Response.json({
        entityId: "entity",
        name,
        file: { fieldId: "field", fileName: name },
      });
    }
    if (url.includes("/url/")) {
      return Response.json({
        presignedUrl: "https://storage.example.test/markdown",
      });
    }
    if (url === "https://storage.example.test/markdown") {
      if (storageFails) {
        return new Response("Storage unavailable", { status: 503 });
      }
      return new Response(publishedText);
    }
    throw new TypeError(`Unexpected transport: ${url}`);
  },
  { preconnect: originalFetch.preconnect },
);

const { useMarkdownFileDraft } = await import("./use-markdown-file-draft");
const { MarkdownFileViewer, MarkdownDraftActions } =
  await import("./markdown-file-viewer");
const { filesKeys } = await import("@/lib/files/queries");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { useRenameEntity } = await import("@/lib/workspaces/mutations/entities");
// Load the real browser engine before installing fake timers (lazy loading may
// otherwise schedule its mount beyond the test's explicit debounce advances).
const { MarkdownHybridEditor } =
  await import("@/components/markdown/markdown-hybrid-editor.impl");

const fileTab: FileTab = {
  type: "pdf",
  id: "field",
  entityId: "entity",
  workspaceId: "matter",
  label: "original.md",
  fileName: "original.md",
  mimeType: "text/markdown",
  pdfFileId: null,
};

const Panel = ({ tab }: { tab: FileTab }) => {
  const t = useTranslations();
  const draft = useMarkdownFileDraft({
    tab,
    isMarkdownDisplay: true,
    filePropertyId: "property",
  });
  const rename = useRenameEntity();
  return (
    <>
      <MarkdownFileViewer draft={draft} readOnly={false} tabId={tab.id} />
      <MarkdownDraftActions draft={draft} />
      <button
        type="button"
        onClick={() =>
          rename.mutate({
            workspaceId: tab.workspaceId,
            entityId: tab.entityId,
            name: "renamed.md",
          })
        }
      >
        {t("common.rename")}
      </button>
    </>
  );
};
const Inspector = () => {
  const tab = useInspectorTabsStore((state) => state.tabs.at(0));
  if (tab?.type !== "pdf") {
    throw new TypeError("Expected a file tab");
  }
  return <Panel key={tab.renderId ?? tab.id} tab={tab} />;
};

const mount = async () => {
  useInspectorTabsStore.getState().openFile(fileTab);
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  client.setQueryData(
    filesKeys.textByFieldId({ workspaceId: "matter", fieldId: "field" }),
    {
      text: publishedText,
      fileId: "file",
      fileName: "original.md",
      mimeType: "text/markdown",
      originalMimeType: "text/markdown",
    },
  );
  const view = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={englishMessages}>
        <AuthenticatedUserProvider
          user={{
            activeOrganizationId: "org",
            id: "user",
            email: "editor@example.test",
            image: null,
            name: "Editor",
            preferredName: null,
            timezoneId: "UTC",
            wordEditShortcut: null,
          }}
        >
          <Inspector />
        </AuthenticatedUserProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(view.container.querySelector(".md-editor")).not.toBeNull(),
  );
  jest.useFakeTimers();
  return { ...view, client };
};

// Drive the real controller through its browser input boundary, replacing the
// entire source so model content and the rendered blocks can both be asserted.
const editorContext = (container: HTMLElement) => {
  const element = container.querySelector(".md-editor");
  if (!(element instanceof HTMLElement) || !("editContext" in element)) {
    throw new TypeError("Expected the mounted EditContext");
  }
  const context = element.editContext;
  if (
    !(context instanceof EventTarget) ||
    !("text" in context) ||
    typeof context.text !== "string"
  ) {
    throw new TypeError("Expected the EditContext source");
  }
  return { target: context, text: context.text };
};
const edit = (container: HTMLElement, text: string) => {
  const context = editorContext(container);
  act(() => {
    context.target.dispatchEvent(
      Object.assign(new Event("textupdate"), {
        text,
        updateRangeStart: 0,
        updateRangeEnd: context.text.length,
        selectionStart: text.length,
        selectionEnd: text.length,
      }),
    );
  });
};
const advance = async (ms: number) => {
  await act(async () => jest.advanceTimersByTime(ms));
  await act(async () => {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  });
};
const startTransport = async () => {
  // Eden's browser multipart path uses two FileReader timer stages. Each
  // stage is scheduled after an async continuation, independently of debounce.
  await advance(1);
  await advance(1);
  await advance(1);
  expect(requests).toHaveLength(1);
};
const publish = async () => {
  const request = requests.at(0);
  if (!request) {
    throw new TypeError("Expected a publication request");
  }
  publishedText = await request.file.text();
  await act(async () =>
    request.answer.resolve(
      Response.json({
        fieldId: "next-field",
        versionId: "version",
        versionNumber: 2,
      }),
    ),
  );
  await waitFor(() =>
    expect(useInspectorTabsStore.getState().tabs.at(0)?.id).toBe("next-field"),
  );
};

afterEach(async () => {
  jest.useRealTimers();
  await act(async () => cleanup());
  requests.length = 0;
  publishedText = "Server text";
  storageFails = false;
  useInspectorTabsStore.setState({ tabs: [], activeId: null });
  localArea().clear();
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await GlobalRegistrator.unregister();
});

test("publication captures the displayed source inside the debounce interval", async () => {
  const view = await mount();
  edit(view.container, "Draft A");
  await advance(400);
  edit(view.container, "Draft B");
  fireEvent.click(view.getByRole("button", { name: "Save" }));
  await startTransport();
  jest.useRealTimers();
  expect(await requests.at(0)?.file.text()).toBe("Draft B");
  await publish();
  expect(view.container.textContent).toContain("Draft B");
  expect(view.queryByRole("button", { name: "Save" })).toBeNull();
});

test.each([true, false])(
  "publication locks the model until settlement (success=%s) and resumes editing",
  async (succeeded) => {
    const view = await mount();
    edit(view.container, "Draft B");
    await advance(400);
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    await startTransport();
    edit(view.container, "Draft C");
    await advance(400);
    expect(view.container.textContent).toContain("Draft B");
    expect(view.container.textContent).not.toContain("Draft C");
    expect(
      view.getByRole("button", { name: "Cancel" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(view.container.querySelector(".md-readonly-toggle")).toBeNull();
    const editor = view.container.querySelector(".md-editor");
    if (!(editor instanceof HTMLElement)) {
      throw new TypeError("Expected the mounted editor");
    }
    expect(editor.getAttribute("aria-keyshortcuts")).toBe("Control+M");
    expect(editor.getAttribute("aria-description")).toContain("Tab");
    fireEvent.keyDown(editor, { key: "e", metaKey: true });
    edit(view.container, "Draft C");
    expect(view.container.textContent).not.toContain("Draft C");
    jest.useRealTimers();
    if (succeeded) {
      await publish();
      await waitFor(() =>
        expect(view.container.querySelector(".md-editor")).not.toBeNull(),
      );
    } else {
      await act(async () =>
        requests
          .at(0)
          ?.answer.resolve(
            Response.json({ message: "Publication refused" }, { status: 409 }),
          ),
      );
      await waitFor(() =>
        expect(
          view.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
        ).toBe(false),
      );
    }
    jest.useFakeTimers();
    edit(view.container, "Draft C");
    await advance(400);
    expect(view.container.textContent).toContain("Draft C");
    expect(
      view.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
    ).toBe(false);
  },
);

test("cancel restores the model and cancels a pending emission before later input", async () => {
  const view = await mount();
  edit(view.container, "Draft A");
  await advance(400);
  edit(view.container, "Cancelled B");
  fireEvent.click(view.getByRole("button", { name: "Cancel" }));
  expect(view.container.textContent).toContain("Server text");
  expect(view.container.textContent).not.toContain("Cancelled B");
  await advance(400);
  expect(view.queryByRole("button", { name: "Save" })).toBeNull();
  const context = editorContext(view.container);
  expect(context.text).toBe("Server text");
  act(() => {
    context.target.dispatchEvent(
      Object.assign(new Event("textupdate"), {
        text: " appended",
        updateRangeStart: 11,
        updateRangeEnd: 11,
        selectionStart: 20,
        selectionEnd: 20,
      }),
    );
  });
  await advance(400);
  fireEvent.click(view.getByRole("button", { name: "Save" }));
  await startTransport();
  jest.useRealTimers();
  expect(await requests.at(0)?.file.text()).toBe("Server text appended");
});

test("a failed background refetch keeps the retained draft publishable", async () => {
  const view = await mount();
  edit(view.container, "Draft A");
  await advance(400);
  jest.useRealTimers();
  storageFails = true;
  await act(async () =>
    view.client.refetchQueries({
      queryKey: filesKeys.textByFieldId({
        workspaceId: "matter",
        fieldId: "field",
      }),
    }),
  );
  await waitFor(() =>
    expect(view.container.querySelector(".md-editor")).toBeNull(),
  );
  fireEvent.click(view.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(await requests.at(0)?.file.text()).toBe("Draft A");
});

test("rename metadata owns the name used by subsequent publication", async () => {
  const view = await mount();
  edit(view.container, "Draft A");
  await advance(400);
  jest.useRealTimers();
  fireEvent.click(view.getByRole("button", { name: "Rename" }));
  await waitFor(() =>
    expect(useInspectorTabsStore.getState().tabs.at(0)).toMatchObject({
      fileName: "renamed.md",
      label: "renamed.md",
    }),
  );
  fireEvent.click(view.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests.at(0)?.file.name).toBe("renamed.md");
  await publish();
  expect(useInspectorTabsStore.getState().tabs.at(0)).toMatchObject({
    id: "next-field",
    fileName: "renamed.md",
    label: "renamed.md",
  });
});

test("publication settlement preserves metadata confirmed while it was pending", async () => {
  const view = await mount();
  edit(view.container, "Draft A");
  await advance(400);
  fireEvent.click(view.getByRole("button", { name: "Save" }));
  await startTransport();
  jest.useRealTimers();
  fireEvent.click(view.getByRole("button", { name: "Rename" }));
  await waitFor(() =>
    expect(useInspectorTabsStore.getState().tabs.at(0)).toMatchObject({
      label: "renamed.md",
      fileName: "renamed.md",
    }),
  );
  await publish();
  expect(useInspectorTabsStore.getState().tabs.at(0)).toMatchObject({
    id: "next-field",
    label: "renamed.md",
    fileName: "renamed.md",
  });
});

test("editor resets are fixed points for source and pending notifications", async () => {
  await assertProperty(
    "editor resets are fixed points for source and pending notifications",
    fc.asyncProperty(fc.string(), async (source) => {
      const handle = React.createRef<MarkdownHybridEditorHandle>();
      const changes: string[] = [];
      const view = render(
        <IntlProvider locale="en" messages={englishMessages}>
          <MarkdownHybridEditor
            ref={handle}
            markdown="Server text"
            imagePolicy="data-only"
            onMarkdownChange={(next) => {
              changes.push(next);
            }}
          />
        </IntlProvider>,
      );
      jest.useFakeTimers();
      edit(view.container, "Pending edit");
      act(() => handle.current?.resetMarkdown(source));
      act(() => handle.current?.resetMarkdown(source));
      expect(handle.current?.captureForSave()).toBe(source);
      // The imperative snapshot locks synchronously, before a host can commit
      // its pending-state render, and covers every generated source string.
      edit(view.container, "Later edit");
      expect(handle.current?.captureForSave()).toBe(source);
      await advance(400);
      expect(changes).toEqual([source, source]);
      await act(async () => view.unmount());
      expect(changes).toEqual([source, source]);
      jest.useRealTimers();
    }),
    { numRuns: 25 },
  );
});
