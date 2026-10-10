import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import * as v from "valibot";
import { createStore } from "zustand";
import type { StoreApi } from "zustand";
import { immer } from "zustand/middleware/immer";

import {
  ACTION_ADMISSION_CODES,
  ACTION_ADMISSION_REFUSALS,
} from "@stll/api-contract/action-admission";
import { stellaToast } from "@stll/ui/toast";

import type { DownloadVariant } from "@/components/inspector/file-download-service.logic";
import type { FileTab } from "@/components/inspector/inspector-store-types";
import englishMessages from "@/i18n/langs/en.json";
import { browserStorage } from "@/lib/account/browser-storage";
import { userStorageKey } from "@/lib/account/user-scoped-storage";
import { unregisterDomEnvironment } from "@/test-dom-environment";

import type { InspectorTabsStore } from "./inspector-store-types";

const localArea = () =>
  browserStorage("local") ?? panic("Test requires local browser storage");

const NativeBroadcastChannel = globalThis.BroadcastChannel;
GlobalRegistrator.register({ url: "http://localhost:3000" });
window.BroadcastChannel = NativeBroadcastChannel;
const React = await import("react");
const { QueryClient, QueryClientProvider, useQuery } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { act, cleanup, renderHook, waitFor } =
  await import("@testing-library/react");
const { useFileTabRename } = await import("./use-file-tab-rename");
const { useRenameEntity } = await import("@/lib/workspaces/mutations/entities");
const { useInspectorTabsStore, initializeInspectorTabBroadcast } =
  await import("./inspector-tabs-store");
const { createInspectorTabsSlice } = await import("./inspector-tabs-slice");
const { createInspectorBroadcastSession: broadcast } =
  await import("./inspector-broadcast");
const { getAnalytics } = await import("@/lib/analytics/provider");
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { entityViewKeys } =
  await import("@/lib/workspaces/queries/entity-views");
const { inboxKeys } = await import("@/lib/inbox/queries");
const { entitiesKeys } =
  await import("@/lib/workspaces/queries/entities.logic");
const { fileMetadataByFieldQueryRoot } =
  await import("@/lib/files/file-metadata-query.logic");
const { downloadTabFile } = await import("./file-download-service");
const { toSafeId } = await import("@/lib/safe-id");
const { readStoredJson } = await import("@/lib/stored-json");

const originalActions = {
  updateLabel: useInspectorTabsStore.getState().updateLabel,
  updateFileMetadata: useInspectorTabsStore.getState().updateFileMetadata,
};

const requests: {
  name: string;
  answer: ReturnType<typeof Promise.withResolvers<Response>>;
}[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/rename")) {
      const requestBody = init?.body;
      if (typeof requestBody !== "string") {
        throw new TypeError("Expected a JSON string body for entity rename");
      }
      const body = JSON.parse(requestBody);
      const answer = Promise.withResolvers<Response>();
      requests.push({ name: body.name, answer });
      return await answer.promise;
    }
    if (url.includes("/url/")) {
      return Response.json({
        presignedUrl: "https://storage.example.test/file",
      });
    }
    if (url === "https://storage.example.test/file") {
      return new Response("bytes");
    }
    throw new Error(`Unexpected transport: ${url}`);
  },
  { preconnect: originalFetch.preconnect },
);

const file = (id: string): FileTab => ({
  type: "pdf",
  id: `field-${id}`,
  entityId: id,
  workspaceId: "matter",
  label: `${id}.md`,
  fileName: `${id}.md`,
  pdfFileId: null,
});
const tab = (id: string) =>
  useInspectorTabsStore
    .getState()
    .tabs.find(
      (candidate): candidate is FileTab =>
        candidate.type === "pdf" && candidate.entityId === id,
    );
const mount = (
  inspectorStore: StoreApi<InspectorTabsStore> = useInspectorTabsStore,
  refetch?: () => Promise<string[]>,
) => {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const hook = renderHook(
    () => ({
      fileRename: useFileTabRename({
        tabs: useInspectorTabsStore((s) => s.tabs),
      }),
      entities: useQuery({
        queryKey: entitiesKeys.all("matter"),
        queryFn: async () => (await refetch?.()) ?? [],
        enabled: refetch !== undefined,
        initialData: [],
        staleTime: Infinity,
      }),
      first: useRenameEntity(inspectorStore),
      second: useRenameEntity(inspectorStore),
    }),
    {
      wrapper: ({ children }) =>
        React.createElement(
          QueryClientProvider,
          { client },
          React.createElement(IntlProvider, {
            locale: "en",
            messages: englishMessages,
            children: React.createElement(AuthenticatedUserProvider, {
              user: {
                activeOrganizationId: "org",
                id: "user",
                email: "rename@example.test",
                image: null,
                name: "Rename tester",
                preferredName: null,
                timezoneId: "UTC",
                wordEditShortcut: null,
              },
              children,
            }),
          }),
        ),
    },
  );
  return { ...hook, client };
};
const success = (
  index: number,
  entityId: string,
  name: string,
  fileName = name,
) => {
  const data = {
    entityId: toSafeId<"entity">(entityId),
    name,
    file: {
      fieldId: toSafeId<"field">(`field-${entityId}`),
      fileName: v.parse(
        v.pipe(v.string(), v.brand("SanitizedFileName")),
        fileName,
      ),
    },
  } satisfies NonNullable<ReturnType<typeof useRenameEntity>["data"]>;
  requests.at(index)?.answer.resolve(Response.json(data));
};
const failure = (index: number) =>
  requests
    .at(index)
    ?.answer.resolve(
      Response.json({ message: "Rename refused" }, { status: 409 }),
    );

afterEach(async () => {
  await act(async () => cleanup());
  requests.length = 0;
  useInspectorTabsStore.setState({
    tabs: [],
    activeId: null,
    ...originalActions,
  });
  localArea().clear();
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await unregisterDomEnvironment();
});

describe("confirmed file rename state", () => {
  test("optimistic labels rollback by entity identity after version replacement", async () => {
    useInspectorTabsStore.getState().openFile(file("A"));
    const { result, client } = mount();
    act(() =>
      result.current.first.mutate({
        workspaceId: "matter",
        entityId: "A",
        name: "draft.md",
      }),
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(tab("A")).toMatchObject({ label: "draft.md", fileName: "A.md" });
    act(() =>
      useInspectorTabsStore.getState().replaceFileFieldId("field-A", {
        id: "replacement",
        fileName: "version.md",
      }),
    );
    await act(async () => failure(0));
    await waitFor(() => expect(client.isMutating()).toBe(0));
    expect(tab("A")).toMatchObject({
      id: "replacement",
      label: "A.md",
      fileName: "version.md",
    });
  });

  test("a second window's confirmed rename survives the first window's refusal", async () => {
    const otherStore = createStore<InspectorTabsStore>()(
      immer((set, get) => createInspectorTabsSlice(set, get)),
    );
    const scope = { organizationId: "two-windows", userId: "rename-user" };
    const stopFirst = broadcast(useInspectorTabsStore, scope);
    const stopSecond = broadcast(otherStore, scope);
    try {
      useInspectorTabsStore.getState().openFile(file("A"));
      await waitFor(() => expect(otherStore.getState().tabs).toHaveLength(1));
      const first = mount();
      const second = mount(otherStore);
      act(() =>
        first.result.current.first.mutate({
          workspaceId: "matter",
          entityId: "A",
          name: "refused.md",
        }),
      );
      await waitFor(() => expect(requests).toHaveLength(1));
      await waitFor(() =>
        expect(otherStore.getState().tabs.at(0)?.label).toBe("refused.md"),
      );
      act(() =>
        second.result.current.first.mutate({
          workspaceId: "matter",
          entityId: "A",
          name: "confirmed.md",
        }),
      );
      await waitFor(() => expect(requests).toHaveLength(2));
      await act(async () => success(1, "A", "confirmed.md"));
      await waitFor(() => expect(tab("A")?.fileName).toBe("confirmed.md"));
      await act(async () => failure(0));
      await waitFor(() => expect(first.client.isMutating()).toBe(0));
      expect(tab("A")).toMatchObject({
        label: "confirmed.md",
        fileName: "confirmed.md",
      });
      expect(otherStore.getState().tabs.at(0)).toMatchObject({
        label: "confirmed.md",
        fileName: "confirmed.md",
      });
    } finally {
      stopFirst.dispose();
      stopSecond.dispose();
    }
  });

  test("pending refreshes do not hold completion, pending state or the next rename", async () => {
    useInspectorTabsStore.getState().openFile(file("A"));
    const refresh = Promise.withResolvers<string[]>();
    let refetchCount = 0;
    const { result, client } = mount(useInspectorTabsStore, async () => {
      refetchCount += 1;
      return await refresh.promise;
    });
    const invalidate = spyOn(client, "invalidateQueries");
    const completed: string[] = [];
    try {
      act(() =>
        result.current.first.mutate(
          { workspaceId: "matter", entityId: "A", name: "first.md" },
          {
            onSuccess: () => {
              completed.push("first");
            },
          },
        ),
      );
      await waitFor(() => expect(requests).toHaveLength(1));
      await act(async () => success(0, "A", "first.md"));
      await waitFor(() => expect(result.current.first.isPending).toBe(false));
      expect(completed).toEqual(["first"]);
      expect(refetchCount).toBe(1);
      expect(
        client.getQueryState(entitiesKeys.all("matter"))?.fetchStatus,
      ).toBe("fetching");
      expect(
        new Set(
          invalidate.mock.calls.map(([filters]) =>
            JSON.stringify(filters?.queryKey),
          ),
        ),
      ).toEqual(
        new Set([
          JSON.stringify(entitiesKeys.all("matter")),
          JSON.stringify(entityViewKeys.all("org", "user")),
          JSON.stringify(inboxKeys.all("org", "user")),
          JSON.stringify(
            fileMetadataByFieldQueryRoot({
              workspaceId: "matter",
              fieldId: "field-A",
            }),
          ),
        ]),
      );
      act(() =>
        result.current.first.mutate({
          workspaceId: "matter",
          entityId: "A",
          name: "second.md",
        }),
      );
      await waitFor(() => expect(requests).toHaveLength(2));
      await act(async () => success(1, "A", "second.md"));
      await waitFor(() => expect(client.isMutating()).toBe(0));
      expect(tab("A")?.label).toBe("second.md");
    } finally {
      await act(async () => refresh.resolve([]));
      invalidate.mockRestore();
    }
  });

  test("unmount before settlement still reconciles the store and completion", async () => {
    useInspectorTabsStore.getState().openFile(file("A"));
    const { result, client, unmount } = mount();
    const completed: string[] = [];
    act(() =>
      result.current.first.mutate(
        { workspaceId: "matter", entityId: "A", name: "confirmed.md" },
        {
          onSuccess: () => {
            completed.push("done");
          },
        },
      ),
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    unmount();
    await act(async () => success(0, "A", "confirmed.md"));
    await waitFor(() => expect(client.isMutating()).toBe(0));
    expect(tab("A")).toMatchObject({
      label: "confirmed.md",
      fileName: "confirmed.md",
    });
    expect(completed).toEqual(["done"]);
  });

  test("version-pinned tabs receive the label and keep the displayed version's filename", async () => {
    useInspectorTabsStore
      .getState()
      .openFile({ ...file("A"), id: "older-field", fileName: "older.docx" });
    const { result, client } = mount();
    act(() =>
      result.current.first.mutate({
        workspaceId: "matter",
        entityId: "A",
        name: "current.pdf",
      }),
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => success(0, "A", "current.pdf"));
    await waitFor(() => expect(client.isMutating()).toBe(0));
    expect(tab("A")).toMatchObject({
      id: "older-field",
      label: "current.pdf",
      fileName: "older.docx",
    });
  });

  test("an optimistic store failure releases the next rename", async () => {
    useInspectorTabsStore.getState().openFile(file("A"));
    const { result, client } = mount();
    const update = spyOn(
      useInspectorTabsStore.getState(),
      "updateLabel",
    ).mockImplementationOnce(() => {
      throw new Error("Store unavailable");
    });
    try {
      act(() => {
        result.current.first.mutate({
          workspaceId: "matter",
          entityId: "A",
          name: "first.md",
        });
        result.current.second.mutate({
          workspaceId: "matter",
          entityId: "A",
          name: "second.md",
        });
      });
      await waitFor(() => expect(requests).toHaveLength(1));
      expect(requests.at(0)?.name).toBe("second.md");
      await act(async () => success(0, "A", "second.md"));
      await waitFor(() => expect(client.isMutating()).toBe(0));
      expect(tab("A")?.fileName).toBe("second.md");
    } finally {
      update.mockRestore();
    }
  });

  test("a success store failure does not rollback a committed rename or show action failed", async () => {
    useInspectorTabsStore.getState().openFile(file("A"));
    const { result, client } = mount();
    const update = spyOn(
      useInspectorTabsStore.getState(),
      "updateFileMetadata",
    ).mockImplementationOnce(() => {
      throw new Error("Store unavailable");
    });
    const toast = spyOn(stellaToast, "add");
    try {
      act(() =>
        result.current.first.mutate({
          workspaceId: "matter",
          entityId: "A",
          name: "confirmed.md",
        }),
      );
      await waitFor(() => expect(requests).toHaveLength(1));
      await act(async () => success(0, "A", "confirmed.md"));
      await waitFor(() => expect(client.isMutating()).toBe(0));
      expect(result.current.first.isSuccess).toBe(true);
      expect(tab("A")?.label).toBe("confirmed.md");
      expect(toast).not.toHaveBeenCalled();
    } finally {
      update.mockRestore();
      toast.mockRestore();
    }
  });

  test("each tab settles when a later tab succeeds before its refusal", async () => {
    useInspectorTabsStore.getState().openFile(file("A"));
    useInspectorTabsStore.getState().openFile(file("B"));
    const { result } = mount();
    for (const id of ["A", "B"]) {
      act(() => result.current.fileRename.setEditValue(`new-${id}`));
      act(() => result.current.fileRename.commitRename(file(id)));
    }
    await waitFor(() => expect(requests).toHaveLength(2));
    await act(async () => success(1, "B", "new-B.md"));
    await waitFor(() => expect(tab("B")?.label).toBe("new-B.md"));
    await act(async () => failure(0));
    await waitFor(() => expect(tab("A")?.label).toBe("A.md"));
    expect(tab("A")?.fileName).toBe("A.md");
    expect(tab("B")?.fileName).toBe("new-B.md");
  });

  test("a shared observer delivers every invocation's completion", async () => {
    const { result, client } = mount();
    const completed: string[] = [];
    act(() => {
      result.current.first.mutate(
        { workspaceId: "matter", entityId: "A", name: "A.md" },
        {
          onError: () => {
            completed.push("A-error");
          },
        },
      );
      result.current.first.mutate(
        { workspaceId: "matter", entityId: "B", name: "B.md" },
        {
          onSuccess: () => {
            completed.push("B-ok");
          },
        },
      );
    });
    await waitFor(() => expect(requests).toHaveLength(2));
    await act(async () => success(1, "B", "B.md"));
    await waitFor(() => expect(completed).toEqual(["B-ok"]));
    await act(async () => failure(0));
    await waitFor(() => expect(client.isMutating()).toBe(0));
    expect(completed).toEqual(["B-ok", "A-error"]);
  });

  test("a failed completion cannot undo a committed name or hold the next rename", async () => {
    useInspectorTabsStore.getState().openFile(file("A"));
    const { result, client } = mount();
    act(() => {
      result.current.first.mutate(
        { workspaceId: "matter", entityId: "A", name: "first.md" },
        {
          onSuccess: () => {
            throw new Error("Completion unavailable");
          },
        },
      );
      result.current.first.mutate({
        workspaceId: "matter",
        entityId: "A",
        name: "second.md",
      });
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => success(0, "A", "first.md"));
    await waitFor(() => expect(requests).toHaveLength(2));
    await act(async () => failure(1));
    await waitFor(() => expect(client.isMutating()).toBe(0));
    expect(tab("A")).toMatchObject({ label: "first.md", fileName: "first.md" });
  });

  test("matching entity ids in different matters run independently", async () => {
    useInspectorTabsStore.setState({
      tabs: [
        file("A"),
        {
          ...file("A"),
          id: "other-field",
          workspaceId: "other",
          label: "other.md",
          fileName: "other.md",
        },
      ],
    });
    const { result, client } = mount();
    act(() => {
      result.current.first.mutate({
        workspaceId: "matter",
        entityId: "A",
        name: "one.md",
      });
      result.current.first.mutate({
        workspaceId: "other",
        entityId: "A",
        name: "two.md",
      });
    });
    await waitFor(() => expect(requests).toHaveLength(2));
    await act(async () => success(1, "A", "two.md"));
    await act(async () => failure(0));
    await waitFor(() => expect(client.isMutating()).toBe(0));
    expect(useInspectorTabsStore.getState().tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "field-A",
          label: "A.md",
          fileName: "A.md",
        }),
        expect.objectContaining({
          id: "other-field",
          label: "two.md",
          fileName: "other.md",
        }),
      ]),
    );
  });

  test("a refresh refusal leaves committed metadata confirmed", async () => {
    useInspectorTabsStore.getState().openFile(file("A"));
    const { result, client } = mount();
    const toast = spyOn(stellaToast, "add");
    const capture = spyOn(getAnalytics(), "captureError");
    const invalidate = spyOn(client, "invalidateQueries").mockRejectedValue(
      new Error("Refresh unavailable"),
    );
    act(() =>
      result.current.first.mutate({
        workspaceId: "matter",
        entityId: "A",
        name: "confirmed.md",
      }),
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => success(0, "A", "confirmed.md"));
    await waitFor(() => expect(client.isMutating()).toBe(0));
    expect(tab("A")).toMatchObject({
      label: "confirmed.md",
      fileName: "confirmed.md",
    });
    expect(result.current.first.isSuccess).toBe(true);
    expect(toast).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledWith(expect.any(Error), {
      type: "detached",
      operation: "entity-rename.refresh",
    });
    capture.mockRestore();
    toast.mockRestore();
    invalidate.mockRestore();
  });

  test("a throwing refusal completion releases the next invocation", async () => {
    useInspectorTabsStore.getState().openFile(file("A"));
    const { result, client } = mount();
    act(() => {
      result.current.first.mutate(
        { workspaceId: "matter", entityId: "A", name: "first.md" },
        {
          onError: () => {
            throw new Error("Completion unavailable");
          },
        },
      );
      result.current.first.mutate({
        workspaceId: "matter",
        entityId: "A",
        name: "second.md",
      });
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => failure(0));
    await waitFor(() => expect(requests).toHaveLength(2));
    await act(async () => success(1, "A", "second.md"));
    await waitFor(() => expect(client.isMutating()).toBe(0));
    expect(tab("A")).toMatchObject({
      label: "second.md",
      fileName: "second.md",
    });
  });

  test("completion after closing a tab leaves it closed", async () => {
    useInspectorTabsStore.getState().openFile(file("A"));
    const { result, client } = mount();
    act(() =>
      result.current.first.mutate({
        workspaceId: "matter",
        entityId: "A",
        name: "new.md",
      }),
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    act(() => useInspectorTabsStore.getState().closeTab("field-A"));
    await act(async () => success(0, "A", "new.md"));
    await waitFor(() => expect(client.isMutating()).toBe(0));
    expect(useInspectorTabsStore.getState().tabs).toEqual([]);
  });

  for (const firstSucceeds of [true, false]) {
    for (const secondSucceeds of [true, false]) {
      test(`same entity across observers: ${firstSucceeds}/${secondSucceeds}`, async () => {
        useInspectorTabsStore.getState().openFile(file("A"));
        const { result, client } = mount();
        const completed: string[] = [];
        act(() => {
          result.current.first.mutate(
            { workspaceId: "matter", entityId: "A", name: "first.md" },
            {
              onSuccess: () => {
                completed.push("first-ok");
              },
              onError: () => {
                completed.push("first-error");
              },
            },
          );
          result.current.second.mutate(
            { workspaceId: "matter", entityId: "A", name: "second.md" },
            {
              onSuccess: () => {
                completed.push("second-ok");
              },
              onError: () => {
                completed.push("second-error");
              },
            },
          );
        });
        await waitFor(() => expect(requests.length).toBeGreaterThan(0));
        expect(requests).toHaveLength(1);
        await act(async () =>
          firstSucceeds ? success(0, "A", "first.md") : failure(0),
        );
        await waitFor(() => expect(requests).toHaveLength(2));
        await act(async () =>
          secondSucceeds ? success(1, "A", "second.md") : failure(1),
        );
        await waitFor(() => expect(client.isMutating()).toBe(0));
        const firstConfirmed = firstSucceeds ? "first.md" : "A.md";
        const confirmed = secondSucceeds ? "second.md" : firstConfirmed;
        expect(tab("A")).toMatchObject({
          label: confirmed,
          fileName: confirmed,
        });
        expect(completed).toEqual([
          firstSucceeds ? "first-ok" : "first-error",
          secondSucceeds ? "second-ok" : "second-error",
        ]);
      });
    }
  }

  test("unchanged field identity persists canonical metadata and downloads with it", async () => {
    const stopBroadcast = initializeInspectorTabBroadcast({
      organizationId: "org-rename",
      userId: "user-rename",
    });
    useInspectorTabsStore.getState().openFile(file("A"));
    const { result, client } = mount();
    act(() =>
      result.current.first.mutate({
        workspaceId: "matter",
        entityId: "A",
        name: "requested.md",
      }),
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () =>
      success(0, "A", "canonical/name.md", "canonical_name.md"),
    );
    await waitFor(() => expect(client.isMutating()).toBe(0));
    const renamed = tab("A");
    expect(renamed).toMatchObject({
      id: "field-A",
      label: "canonical/name.md",
      fileName: "canonical_name.md",
    });
    expect(
      readStoredJson(
        localArea().getItem(
          userStorageKey("stella:inspector-state:v1:org-rename:", {
            kind: "user",
            userId: "user-rename",
          }),
        ),
        v.object({
          tabs: v.array(v.object({ label: v.string(), fileName: v.string() })),
        }),
      )?.tabs,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "canonical/name.md",
          fileName: "canonical_name.md",
        }),
      ]),
    );
    const downloads: string[] = [];
    const click = spyOn(
      HTMLAnchorElement.prototype,
      "click",
    ).mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    if (!renamed) {
      throw new Error("Confirmed tab missing");
    }
    await downloadTabFile({
      fieldId: renamed.id,
      fileName: renamed.fileName,
      workspaceId: renamed.workspaceId,
      variant: "original",
      onError: (message) => {
        throw new Error(message);
      },
    });
    expect(downloads).toEqual(["canonical_name.md"]);
    click.mockRestore();
    stopBroadcast();
  });
});

test("download errors preserve every admission refusal for all renditions", async () => {
  const { actionAdmissionOutcome } =
    await import("@/lib/errors/action-admission");
  const variants = {
    original: "original",
    pdf: "pdf",
    reference: "reference",
    "reference-scrubbed": "reference-scrubbed",
    scrubbed: "scrubbed",
  } as const satisfies Record<DownloadVariant, DownloadVariant>;
  for (const variant of Object.values(variants)) {
    for (const code of Object.values(ACTION_ADMISSION_CODES)) {
      const refusal = ACTION_ADMISSION_REFUSALS[code];
      const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
        Response.json({ code, message: "Refused" }, { status: refusal.status }),
      );
      const errors: unknown[] = [];
      try {
        await downloadTabFile({
          fieldId: "field-refused",
          fileName: "refused.docx",
          workspaceId: "matter",
          variant,
          onError: (_message, error) => {
            errors.push(error);
          },
        });
        expect(errors).toHaveLength(1);
        expect(actionAdmissionOutcome(errors.at(0))?.code).toBe(code);
      } finally {
        fetch.mockRestore();
      }
    }
  }
});

test("original and PDF download refusals retain localized status reasons without raw server details", async () => {
  const { APIError, toAPIError } = await import("@/lib/errors/api");
  const { notifyUserError } = await import("@/lib/errors/user-toast");
  const privateMessage = "Private storage account and object details";
  for (const variant of ["original", "pdf"] as const) {
    for (const status of [403, 404, 409, 500]) {
      const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
        Response.json({ message: privateMessage }, { status }),
      );
      const toast = spyOn(stellaToast, "add").mockReturnValue("failure");
      const errors: unknown[] = [];
      try {
        await downloadTabFile({
          fieldId: "field-refused",
          fileName: "refused.docx",
          workspaceId: "matter",
          variant,
          onError: (message, error) => {
            errors.push(error);
            notifyUserError(error, message);
          },
        });
        expect(errors).toHaveLength(1);
        expect(APIError.is(errors.at(0))).toBe(true);
        const expected = toAPIError({
          status,
          value: { message: privateMessage },
        });
        expect(expected.message).not.toBe(privateMessage);
        expect(toast).toHaveBeenCalledTimes(1);
        expect(toast.mock.calls.at(0)?.at(0)).toMatchObject({
          title: expected.message,
          type: "error",
        });
        expect(JSON.stringify(toast.mock.calls)).not.toContain(privateMessage);
      } finally {
        toast.mockRestore();
        fetch.mockRestore();
      }
    }
  }
});
