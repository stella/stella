import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import * as v from "valibot";

import type { FileTab } from "@/components/inspector/inspector-store-types";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const React = await import("react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { act, cleanup, renderHook, waitFor } =
  await import("@testing-library/react");
const { useFileTabRename } = await import("./use-file-tab-rename");
const { useRenameEntity } = await import("@/lib/workspaces/mutations/entities");
const { useInspectorTabsStore, initializeInspectorTabBroadcast } =
  await import("./inspector-tabs-store");
const { downloadTabFile } = await import("./file-download-service");
const { toSafeId } = await import("@/lib/safe-id");
const { readStoredJson } = await import("@/lib/stored-json");

const requests: {
  name: string;
  answer: ReturnType<typeof Promise.withResolvers<Response>>;
}[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/rename")) {
      const body = JSON.parse(String(init?.body));
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
const mount = () => {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const hook = renderHook(
    () => ({
      fileRename: useFileTabRename({
        tabs: useInspectorTabsStore((s) => s.tabs),
      }),
      first: useRenameEntity(),
      second: useRenameEntity(),
    }),
    {
      wrapper: ({ children }) =>
        React.createElement(
          QueryClientProvider,
          { client },
          React.createElement(IntlProvider, {
            locale: "en",
            messages: { errors: { actionFailed: "Action failed" } },
            children,
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
  useInspectorTabsStore.setState({ tabs: [], activeId: null });
  window.localStorage.clear();
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await GlobalRegistrator.unregister();
});

describe("confirmed file rename state", () => {
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
          fileName: "two.md",
        }),
      ]),
    );
  });

  test("a refresh refusal leaves committed metadata confirmed", async () => {
    useInspectorTabsStore.getState().openFile(file("A"));
    const { result, client } = mount();
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
        window.localStorage.getItem(
          "stella:inspector-state:v1:org-rename:user-rename",
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
