import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  spyOn,
  test,
} from "bun:test";

import type { ClauseParagraph } from "@/components/templates/clause-editor-types";
import englishMessages from "@/i18n/langs/en.json";

import type { ClauseDetailTransport, ClauseHead } from "./clause-detail";
import type { ClauseBodyWrite } from "./use-clause-body-save";

GlobalRegistrator.register({ url: "http://localhost:3000/knowledge" });
// Importing the real page also initializes the auth client. Its unauthenticated
// session probe is the only ambient transport this harness permits.
const fetchBoundary = spyOn(globalThis, "fetch").mockImplementation(
  async (input) => {
    let url;
    if (typeof input === "string") {
      url = new URL(input, "http://localhost:3000");
    } else if (input instanceof URL) {
      url = input;
    } else {
      url = new URL(input.url);
    }
    if (url.pathname.startsWith("/api/auth/")) {
      return Response.json(null);
    }
    throw new Error(
      `unexpected network transport in clause test: ${url.pathname}`,
    );
  },
);
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { act, cleanup, fireEvent, render, within } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { Editor } = await import("@tiptap/core");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { useClauseNavStore } =
  await import("@/stores/knowledge/clause-nav-store");
const { stellaToast } = await import("@stll/ui/toast");
const { APIError } = await import("@/lib/errors/api");
const { knowledgeKeys, clauseDetailOptions } =
  await import("@/lib/knowledge/queries");
const { DetailContent } = await import("./clause-detail");
const { clauseBodyToTipTap } = await import("./clause-editor-tiptap");
const A = [{ text: "Initial clause" }];
const B = [{ text: "Edited clause" }];
const C = [{ text: "Later edit" }];
const R1 = [{ text: "First reviewed revision" }];
const R2 = [{ text: "Second reviewed revision" }];
const HISTORY = [{ text: "Historical clause" }];
const REMOTE = [{ text: "Another writer" }];
const VERSION = {
  id: "version_1",
  version: 1,
  createdAt: "2026-01-01T00:00:00Z",
};
const DETAIL = {
  id: "clause_1",
  title: "Clause title",
  categoryId: null,
  description: null,
  usageNotes: null,
  language: null,
  body: A,
  currentVersion: 1,
  createdAt: VERSION.createdAt,
  updatedAt: VERSION.createdAt,
  variants: [
    {
      id: "variant_1",
      label: "Alternative",
      body: HISTORY,
      sortOrder: 0,
      createdAt: VERSION.createdAt,
    },
  ],
  versions: [VERSION],
} satisfies Parameters<typeof DetailContent>[0]["detail"];
type Operation =
  | { type: "save"; write: ClauseBodyWrite }
  | { type: "restore"; versionId: string; expectedBody: ClauseParagraph[] }
  | {
      type: "promote";
      body: ClauseParagraph[];
      expectedBody: ClauseParagraph[];
    };

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});
afterAll(async () => {
  fetchBoundary.mockRestore();
  jest.restoreAllMocks();
  await GlobalRegistrator.unregister();
});

const mountDetail = () => {
  const requests: (Operation & {
    deferred: ReturnType<typeof Promise.withResolvers<ClauseHead>>;
  })[] = [];
  const starts = new Map<
    number,
    ReturnType<typeof Promise.withResolvers<undefined>>
  >();
  const rewrites: ReturnType<
    typeof Promise.withResolvers<ClauseParagraph[]>
  >[] = [];
  const rewriteStarts = new Map<
    number,
    ReturnType<typeof Promise.withResolvers<undefined>>
  >();
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const key = knowledgeKeys.clauses.detail("org_1", DETAIL.id);
  queryClient.setQueryData(key, DETAIL);
  let head: ClauseHead = {
    body: A,
    currentVersion: 1,
    updatedAt: VERSION.createdAt,
  };
  let departures = 0;
  const toast = spyOn(stellaToast, "add").mockReturnValue("clause-test-toast");
  toast.mockClear();
  const request = async (operation: Operation) => {
    const deferred = Promise.withResolvers<ClauseHead>();
    const index = requests.length;
    requests.push({ ...operation, deferred });
    starts.get(index)?.resolve(undefined);
    return deferred.promise;
  };
  const transport = {
    save: (write) => request({ type: "save", write }),
    read: async () => head.body,
    restore: (versionId, expectedBody) =>
      request({ type: "restore", versionId, expectedBody }),
    promote: (body, expectedBody) =>
      request({ type: "promote", body, expectedBody }),
    rewrite: async () => {
      const deferred = Promise.withResolvers<ClauseParagraph[]>();
      const index = rewrites.length;
      rewrites.push(deferred);
      rewriteStarts.get(index)?.resolve(undefined);
      return deferred.promise;
    },
  } satisfies ClauseDetailTransport;
  const content = (detail: typeof DETAIL) => (
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={englishMessages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <button
            type="button"
            onClick={() => useClauseNavStore.getState().open?.exit()}
          >
            {englishMessages.clauses.backToList}
          </button>
          <DetailContent
            organizationId="org_1"
            detail={detail}
            clauseId={DETAIL.id}
            categories={[]}
            canEdit
            canDelete={false}
            onBack={() => {
              departures += 1;
            }}
            onDeleted={() => {}}
            onRefresh={() => {}}
            transport={transport}
          />
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>
  );
  let view = render(content(DETAIL));
  const editor = () => {
    const element = view.container.querySelector(".tiptap");
    if (
      !element ||
      !("editor" in element) ||
      !(element.editor instanceof Editor)
    ) {
      throw new Error("expected the real mounted clause editor");
    }
    return element.editor;
  };
  const click = async (button: HTMLElement) =>
    act(async () => {
      fireEvent.click(button);
    });
  const edit = async (body: ClauseParagraph[]) =>
    act(() => {
      editor().commands.setContent(clauseBodyToTipTap(body));
    });
  const tick = async () =>
    act(async () => {
      jest.advanceTimersByTime(1200);
    });
  const started = async (index: number) => {
    await act(async () => {
      if (requests.at(index)) {
        return;
      }
      const barrier = Promise.withResolvers<undefined>();
      starts.set(index, barrier);
      await barrier.promise;
    });
    const pending = requests.at(index);
    if (!pending) {
      throw new Error("expected detail write transport to start");
    }
    return pending;
  };
  const settle = async (
    index: number,
    body: ClauseParagraph[],
    failure?: unknown,
  ) => {
    const pending = await started(index);
    await act(async () => {
      if (failure !== undefined) {
        pending.deferred.reject(failure);
        return;
      }
      const publication =
        pending.type !== "save" || pending.write.snapshotVersion === true;
      head = {
        body,
        currentVersion: head.currentVersion + (publication ? 1 : 0),
        updatedAt: "2026-01-02T00:00:00Z",
      };
      pending.deferred.resolve(head);
    });
  };
  const rewrite = async (index: number, body: ClauseParagraph[]) => {
    await click(
      view.getByRole("button", {
        name: englishMessages.ai.editWithAI,
        exact: true,
      }),
    );
    await act(async () => {
      if (!rewrites.at(index)) {
        const barrier = Promise.withResolvers<undefined>();
        rewriteStarts.set(index, barrier);
        await barrier.promise;
      }
      const pending = rewrites.at(index);
      if (!pending) {
        throw new Error("expected injected rewrite transport");
      }
      pending.resolve(body);
    });
  };
  const saveButton = () =>
    view.getByRole("button", { name: englishMessages.clauses.saveAsVersion });
  const rerenderBody = async (body: ClauseParagraph[]) =>
    act(() => view.rerender(content({ ...DETAIL, body })));
  const setRemote = (body: ClauseParagraph[]) => {
    head = { ...head, body };
  };
  const reopen = () => {
    const cached = queryClient.getQueryData(
      clauseDetailOptions("org_1", DETAIL.id).queryKey,
    );
    if (!cached) {
      throw new Error("expected acknowledged head in cache before reopening");
    }
    view.unmount();
    view = render(content({ ...DETAIL, body: cached.body }));
  };
  return {
    get view() {
      return view;
    },
    queryClient,
    key,
    requests,
    toast,
    editor,
    click,
    edit,
    tick,
    started,
    settle,
    rewrite,
    reopen,
    saveButton,
    rerenderBody,
    setRemote,
    head: () => head,
    departures: () => departures,
  };
};

describe("clause detail with the real editor", () => {
  test.each([false, true])(
    "immediate version save retains the live body; later edit=%s",
    async (laterEdit) => {
      const save = mountDetail();
      await save.edit(B);
      await save.click(save.saveButton());
      const pending = await save.started(0);
      expect(pending).toMatchObject({
        type: "save",
        write: { body: B, expectedBody: A, snapshotVersion: true },
      });
      if (laterEdit) {
        await save.edit(C);
      }
      await save.settle(0, B);
      expect(save.head().body).toEqual(B);
      if (!laterEdit) {
        expect(save.saveButton().hasAttribute("disabled")).toBe(true);
        return;
      }
      expect(save.saveButton().hasAttribute("disabled")).toBe(false);
      await save.tick();
      expect(await save.started(1)).toMatchObject({
        type: "save",
        write: { body: C, expectedBody: B },
      });
      await save.settle(1, C);
      expect(save.editor().getText()).toBe("Later edit");
    },
  );

  test.each(["History restore", "variant promotion"])(
    "%s reseeds the mounted editor, reports success, closes the dialog and stays clean",
    async (action) => {
      const save = mountDetail();
      const originalEditor = save.editor();
      if (action === "History restore") {
        await save.click(
          save.view.getByRole("tab", { name: englishMessages.common.history }),
        );
        await save.click(
          save.view.getByRole("button", {
            name: englishMessages.clauses.restoreVersion,
          }),
        );
        await save.click(
          within(save.view.getByRole("alertdialog")).getByRole("button", {
            name: englishMessages.clauses.restoreVersion,
          }),
        );
        expect(await save.started(0)).toMatchObject({
          type: "restore",
          versionId: VERSION.id,
          expectedBody: A,
        });
      } else {
        await save.click(
          save.view.getByRole("tab", {
            name: englishMessages.clauses.variants,
          }),
        );
        const variantRow = save.view.getByText("Alternative").closest("li");
        if (!variantRow) {
          throw new Error("expected the variant row");
        }
        await save.click(
          within(variantRow).getByRole("button", { name: "", exact: true }),
        );
        await save.click(
          save.view.getByRole("menuitem", {
            name: englishMessages.clauses.useAsMainBody,
          }),
        );
        await save.click(
          within(save.view.getByRole("alertdialog")).getByRole("button", {
            name: englishMessages.clauses.useAsMainBody,
          }),
        );
        expect(await save.started(0)).toMatchObject({
          type: "promote",
          body: HISTORY,
          expectedBody: A,
        });
      }
      await save.settle(0, HISTORY);
      expect(save.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "success",
          title:
            action === "History restore"
              ? englishMessages.clauses.versionRestored
              : englishMessages.clauses.variantPromoted,
        }),
      );
      expect(save.view.queryByRole("alertdialog")).toBeNull();
      expect(save.editor()).toBe(originalEditor);
      expect(save.editor().getText()).toBe("Historical clause");
      expect(save.saveButton().hasAttribute("disabled")).toBe(true);
      await save.tick();
      expect(save.requests).toHaveLength(1);
    },
  );

  test.each(["typing", "blur"])(
    "review publication remains blocked after failed persist until %s retry succeeds",
    async (retry) => {
      const save = mountDetail();
      await save.rewrite(0, R1);
      expect(save.saveButton().hasAttribute("disabled")).toBe(true);
      await save.click(
        save.view.getByRole("button", {
          name: englishMessages.docxReview.acceptAll,
        }),
      );
      expect(await save.started(0)).toMatchObject({
        type: "save",
        write: { body: R1, expectedBody: A },
      });
      expect(save.saveButton().hasAttribute("disabled")).toBe(true);
      await save.settle(0, R1, new Error("review persist refused"));
      expect(save.saveButton().hasAttribute("disabled")).toBe(true);
      if (retry === "typing") {
        await save.edit(C);
        await save.tick();
      } else {
        await act(() =>
          save.editor().emit("blur", {
            editor: save.editor(),
            event: new FocusEvent("blur"),
            transaction: save.editor().state.tr,
          }),
        );
      }
      await save.started(1);
      expect(save.saveButton().hasAttribute("disabled")).toBe(true);
      await save.settle(1, retry === "typing" ? C : R1);
      expect(save.saveButton().hasAttribute("disabled")).toBe(false);
      await save.click(save.saveButton());
      expect(await save.started(2)).toMatchObject({
        type: "save",
        write: { snapshotVersion: true, body: retry === "typing" ? C : R1 },
      });
      await save.settle(2, retry === "typing" ? C : R1);
    },
  );

  test("settling an older accepted review cannot open publication during a newer review", async () => {
    const save = mountDetail();
    await save.rewrite(0, R1);
    await save.click(
      save.view.getByRole("button", {
        name: englishMessages.docxReview.acceptAll,
      }),
    );
    await save.started(0);
    await save.rewrite(1, R2);
    await save.settle(0, R1);
    expect(save.saveButton().hasAttribute("disabled")).toBe(true);
    expect(
      save.view.getByRole("button", {
        name: englishMessages.docxReview.acceptAll,
      }),
    ).toBeDefined();
    await save.click(
      save.view.getByRole("button", {
        name: englishMessages.docxReview.acceptAll,
      }),
    );
    await save.started(1);
    expect(save.saveButton().hasAttribute("disabled")).toBe(true);
    await save.settle(1, R2);
    expect(save.saveButton().hasAttribute("disabled")).toBe(false);
  });

  test("fully rejecting another rewrite cannot open publication while an earlier acceptance remains unpersisted", async () => {
    const save = mountDetail();
    await save.rewrite(0, R1);
    await save.click(
      save.view.getByRole("button", {
        name: englishMessages.docxReview.acceptAll,
      }),
    );
    await save.settle(0, R1, new Error("first acceptance unpersisted"));
    await save.rewrite(1, R2);
    await save.click(
      save.view.getByRole("button", {
        name: englishMessages.docxReview.rejectAll,
      }),
    );
    expect(save.saveButton().hasAttribute("disabled")).toBe(true);
    await act(() =>
      save.editor().emit("blur", {
        editor: save.editor(),
        event: new FocusEvent("blur"),
        transaction: save.editor().state.tr,
      }),
    );
    await save.settle(1, R1);
    expect(save.saveButton().hasAttribute("disabled")).toBe(false);
  });

  test("a clean external head delivery reseeds the real editor without a write", async () => {
    const save = mountDetail();
    await save.rerenderBody(REMOTE);
    expect(save.editor().getText()).toBe("Another writer");
    await save.tick();
    expect(save.requests).toHaveLength(0);
    expect(save.saveButton().hasAttribute("disabled")).toBe(true);
  });

  test.each([false, true])(
    "save and leave publishes the live editor body; later edit=%s",
    async (laterEdit) => {
      const save = mountDetail();
      await save.edit(B);
      await save.click(
        save.view.getByRole("button", {
          name: englishMessages.clauses.backToList,
        }),
      );
      await save.click(
        save.view.getByRole("button", {
          name: englishMessages.clauses.saveVersionAndLeave,
        }),
      );
      expect(await save.started(0)).toMatchObject({
        type: "save",
        write: { body: B, expectedBody: A, snapshotVersion: true },
      });
      expect(save.departures()).toBe(0);
      if (laterEdit) {
        await save.click(
          save.view.getByRole("button", {
            name: englishMessages.common.goBackToEditing,
          }),
        );
        await save.edit(C);
      }
      await save.settle(0, B);
      expect(save.departures()).toBe(laterEdit ? 0 : 1);
      expect(save.editor().getText()).toBe(
        laterEdit ? "Later edit" : "Edited clause",
      );
      if (!laterEdit) {
        return;
      }
      await save.tick();
      expect(await save.started(1)).toMatchObject({
        type: "save",
        write: { body: C, expectedBody: B },
      });
      await save.settle(1, C);
    },
  );

  test.each(["leaveWithoutVersion", "saveVersionAndLeave"])(
    "failed %s offers an explicit discard escape",
    async (action) => {
      const save = mountDetail();
      await save.edit(B);
      await save.click(
        save.view.getByRole("button", {
          name: englishMessages.clauses.backToList,
        }),
      );
      await save.click(
        save.view.getByRole("button", {
          name: englishMessages.clauses[action],
        }),
      );
      await save.settle(0, B, new Error("leave persist refused"));
      expect(save.departures()).toBe(0);
      expect(save.editor().getText()).toBe("Edited clause");
      expect(
        save.view.getByText(englishMessages.clauses.saveFailedLeaveDescription),
      ).toBeDefined();
      await save.click(
        save.view.getByRole("button", {
          name: englishMessages.clauses.leaveAndDiscard,
        }),
      );
      expect(save.departures()).toBe(1);
      expect(save.requests).toHaveLength(1);
      expect(save.head().body).toEqual(A);
    },
  );

  test("a review whose persistence failed still offers an explicit leave escape", async () => {
    const save = mountDetail();
    await save.rewrite(0, R1);
    await save.click(
      save.view.getByRole("button", {
        name: englishMessages.docxReview.acceptAll,
      }),
    );
    await save.settle(0, R1, new Error("review unavailable"));
    await save.click(
      save.view.getByRole("button", {
        name: englishMessages.clauses.backToList,
      }),
    );
    expect(
      save.view.getByText(englishMessages.clauses.reviewBeforeLeaving),
    ).toBeDefined();
    await save.click(
      save.view.getByRole("button", {
        name: englishMessages.clauses.leaveAndDiscard,
      }),
    );
    expect(save.departures()).toBe(1);
  });

  test.each(["keepMyText", "takeTheirText"])(
    "an external delivery preserves local text until %s",
    async (choice) => {
      const save = mountDetail();
      await save.edit(B);
      save.setRemote(REMOTE);
      await save.rerenderBody(REMOTE);
      expect(save.editor().getText()).toBe("Edited clause");
      expect(
        save.view.getByText(englishMessages.clauses.saveConflictTitle),
      ).toBeDefined();
      await save.click(
        save.view.getByRole("button", {
          name: englishMessages.clauses[choice],
        }),
      );
      if (choice === "takeTheirText") {
        expect(save.editor().getText()).toBe("Another writer");
        expect(save.saveButton().hasAttribute("disabled")).toBe(true);
        await save.tick();
        expect(save.requests).toHaveLength(0);
        return;
      }
      expect(await save.started(0)).toMatchObject({
        type: "save",
        write: { body: B, expectedBody: REMOTE },
      });
      await save.settle(0, B);
      expect(save.editor().getText()).toBe("Edited clause");
      expect(
        save.view.queryByText(englishMessages.clauses.saveConflictTitle),
      ).toBeNull();
    },
  );

  test.each(["History restore", "variant promotion"])(
    "%s refusal leaves head and editor unchanged",
    async (action) => {
      const save = mountDetail();
      if (action === "History restore") {
        await save.click(
          save.view.getByRole("tab", { name: englishMessages.common.history }),
        );
        await save.click(
          save.view.getByRole("button", {
            name: englishMessages.clauses.restoreVersion,
          }),
        );
        await save.click(
          within(save.view.getByRole("alertdialog")).getByRole("button", {
            name: englishMessages.clauses.restoreVersion,
          }),
        );
      } else {
        await save.click(
          save.view.getByRole("tab", {
            name: englishMessages.clauses.variants,
          }),
        );
        const row = save.view.getByText("Alternative").closest("li");
        if (!row) {
          throw new Error("expected the variant row");
        }
        await save.click(
          within(row).getByRole("button", { name: "", exact: true }),
        );
        await save.click(
          save.view.getByRole("menuitem", {
            name: englishMessages.clauses.useAsMainBody,
          }),
        );
        await save.click(
          within(save.view.getByRole("alertdialog")).getByRole("button", {
            name: englishMessages.clauses.useAsMainBody,
          }),
        );
      }
      await save.settle(
        0,
        HISTORY,
        new APIError({ status: 400, message: "version cap reached" }),
      );
      expect(save.head().body).toEqual(A);
      expect(save.editor().getText()).toBe("Initial clause");
      expect(save.view.getByRole("alertdialog")).toBeDefined();
      expect(save.requests).toHaveLength(1);
      expect(save.toast).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "success" }),
      );
    },
  );

  test("an acknowledged head survives cancelled refetch and reopening from cache", async () => {
    const save = mountDetail();
    const response = Promise.withResolvers<typeof DETAIL>();
    const reading = Promise.withResolvers<undefined>();
    const aborted = Promise.withResolvers<undefined>();
    const refetch = Result.tryPromise(() =>
      save.queryClient.fetchQuery({
        queryKey: save.key,
        staleTime: 0,
        queryFn: async ({ signal }) => {
          signal.addEventListener("abort", () => aborted.resolve(undefined), {
            once: true,
          });
          reading.resolve(undefined);
          return response.promise;
        },
      }),
    );
    await reading.promise;
    await save.edit(B);
    await save.click(save.saveButton());
    await save.settle(0, B);
    await aborted.promise;
    expect((await refetch).isErr()).toBe(true);
    expect(save.queryClient.getQueryData(save.key)).toMatchObject({ body: B });
    await act(() => save.reopen());
    expect(save.editor().getText()).toBe("Edited clause");
    await save.edit(C);
    await save.click(save.saveButton());
    expect(await save.started(1)).toMatchObject({
      type: "save",
      write: { body: C, expectedBody: B, snapshotVersion: true },
    });
    await save.settle(1, C);
  });
});
