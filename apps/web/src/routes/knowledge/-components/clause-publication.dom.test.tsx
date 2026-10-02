import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "bun:test";

import englishMessages from "@/i18n/langs/en.json";

import type { ClauseBodyWrite } from "./use-clause-body-save";

GlobalRegistrator.register({ url: "http://localhost:3000/knowledge" });
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { act, cleanup, fireEvent, render, within } =
  await import("@testing-library/react");
const { Input } = await import("@stll/ui/input");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { useClauseNavStore } =
  await import("@/stores/knowledge/clause-nav-store");
const { ClauseHeader, HistoryTab } = await import("./clause-detail");
const { useClauseBodySave } = await import("./use-clause-body-save");

const A = [{ text: "Initial clause" }];
const B_TEXT = "Edited clause";
const C_TEXT = "Later edit";
const HISTORY_TEXT = "Historical clause";
const B = [{ text: B_TEXT }];
const C = [{ text: C_TEXT }];
const HISTORY = [{ text: HISTORY_TEXT }];
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
  variants: [],
  versions: [VERSION],
} satisfies Parameters<typeof ClauseHeader>[0]["detail"];

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});
afterAll(async () => GlobalRegistrator.unregister());

const drain = async () => {
  for (let index = 0; index < 20; index++) {
    await Promise.resolve();
  }
  jest.advanceTimersByTime(0);
};

const mountPublication = () => {
  const requests: {
    write: ClauseBodyWrite;
    deferred: ReturnType<typeof Promise.withResolvers<unknown>>;
  }[] = [];
  const errors: unknown[] = [];
  const versions: (typeof A)[] = [];
  let head = A;
  let departures = 0;
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const persist = async (write: ClauseBodyWrite) => {
    const deferred = Promise.withResolvers<unknown>();
    requests.push({ write, deferred });
    await deferred.promise;
    head = write.body;
    if (write.snapshotVersion) {
      versions.push(write.body);
    }
  };
  const Harness = () => {
    const save = useClauseBodySave({
      initialBody: A,
      persist,
      onError: (error) => errors.push(error),
    });
    return (
      <>
        <Input
          aria-label="Clause text"
          value={save.body.at(0)?.text ?? ""}
          onChange={(event) => save.change([{ text: event.target.value }])}
        />
        <output aria-label="Version state">
          {save.dirty ? "dirty" : "clean"}
        </output>
        <button
          type="button"
          onClick={() => useClauseNavStore.getState().open?.exit()}
        >
          {englishMessages.common.back}
        </button>
        <ClauseHeader
          detail={DETAIL}
          clauseId={DETAIL.id}
          categories={[]}
          canEdit
          canDelete={false}
          dirtySinceVersion={save.dirty}
          reviewStatus="resolved"
          onBack={() => {
            departures += 1;
          }}
          onDeleted={() => {}}
          onRefresh={() => {}}
          onSaveVersion={save.snapshot}
          onFlushBody={save.flush}
        />
        <HistoryTab
          clauseId={DETAIL.id}
          currentBody={save.body}
          versions={[VERSION]}
          onRestore={async (versionId) => {
            expect(versionId).toBe(VERSION.id);
            return save.restoreFrom(async () => HISTORY);
          }}
        />
      </>
    );
  };
  const view = render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={englishMessages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <Harness />
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  const change = async (text: string) =>
    act(async () => {
      fireEvent.change(view.getByRole("textbox", { name: "Clause text" }), {
        target: { value: text },
      });
      await drain();
    });
  const click = async (button: HTMLElement) =>
    act(async () => {
      fireEvent.click(button);
      await drain();
    });
  const resolve = async (index: number) => {
    const request = requests.at(index);
    expect(request).toBeDefined();
    await act(async () => {
      request?.deferred.resolve(undefined);
      await drain();
    });
  };
  return {
    view,
    requests,
    errors,
    versions,
    change,
    click,
    resolve,
    head: () => head,
    departures: () => departures,
  };
};

describe("clause publication controls", () => {
  test.each([
    { action: "save version", laterEdit: false },
    { action: "save version", laterEdit: true },
    { action: "save and leave", laterEdit: false },
    { action: "save and leave", laterEdit: true },
    { action: "History restore", laterEdit: false },
    { action: "History restore", laterEdit: true },
  ])(
    "$action with laterEdit=$laterEdit publishes through the shared live owner",
    async ({ action, laterEdit }) => {
      const save = mountPublication();
      await save.change(B_TEXT);
      if (action === "save version") {
        await save.click(
          save.view.getByRole("button", {
            name: englishMessages.clauses.saveAsVersion,
          }),
        );
      } else if (action === "save and leave") {
        await save.click(
          save.view.getByRole("button", { name: englishMessages.common.back }),
        );
        await save.click(
          save.view.getByRole("button", {
            name: englishMessages.clauses.saveVersionAndLeave,
          }),
        );
      } else {
        await act(async () => {
          jest.advanceTimersByTime(1200);
          await drain();
        });
        expect(save.requests).toHaveLength(1);
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
        expect(save.requests).toHaveLength(1);
        await save.resolve(0);
        expect(save.view.getByDisplayValue(HISTORY_TEXT)).toBeDefined();
      }
      const captured = action === "History restore" ? HISTORY : B;
      const headIndex = action === "History restore" ? 1 : 0;
      expect(save.requests.at(headIndex)?.write).toEqual({
        body: captured,
        expectedBody: action === "History restore" ? B : A,
      });
      expect(save.requests).toHaveLength(headIndex + 1);
      expect(save.departures()).toBe(0);
      await save.resolve(headIndex);
      expect(save.requests.at(headIndex + 1)?.write).toEqual({
        body: captured,
        expectedBody: captured,
        snapshotVersion: true,
      });
      if (laterEdit) {
        if (action === "History restore") {
          await save.click(
            within(save.view.getByRole("alertdialog")).getByRole("button", {
              name: englishMessages.common.cancel,
            }),
          );
        }
        await save.change(C_TEXT);
      }
      await save.resolve(headIndex + 1);
      expect(save.head()).toEqual(captured);
      expect(save.versions).toEqual([captured]);
      expect(save.view.getByLabelText("Version state").textContent).toBe(
        laterEdit ? "dirty" : "clean",
      );
      expect(save.departures()).toBe(
        action === "save and leave" && !laterEdit ? 1 : 0,
      );
      if (!laterEdit) {
        return;
      }
      await act(async () => {
        jest.advanceTimersByTime(1200);
        await drain();
      });
      expect(save.requests.at(headIndex + 2)?.write).toEqual({
        body: C,
        expectedBody: captured,
      });
      await save.resolve(headIndex + 2);
      expect(save.head()).toEqual(C);
      expect(save.view.getByLabelText("Version state").textContent).toBe(
        "dirty",
      );
    },
  );

  test("save and leave stays mounted when the head write fails", async () => {
    const save = mountPublication();
    await save.change(B_TEXT);
    await save.click(
      save.view.getByRole("button", { name: englishMessages.common.back }),
    );
    await save.click(
      save.view.getByRole("button", {
        name: englishMessages.clauses.saveVersionAndLeave,
      }),
    );
    const failure = new Error("clause write refused");
    await act(async () => {
      save.requests.at(0)?.deferred.reject(failure);
      await drain();
    });
    expect(save.errors).toEqual([failure]);
    expect(save.requests).toHaveLength(1);
    expect(save.versions).toEqual([]);
    expect(save.departures()).toBe(0);
    expect(save.view.getByLabelText("Version state").textContent).toBe("dirty");
  });

  test("leaving without a version waits for the head and stays mounted when that write fails", async () => {
    const save = mountPublication();
    await save.change(B_TEXT);
    await save.click(
      save.view.getByRole("button", { name: englishMessages.common.back }),
    );
    await save.click(
      save.view.getByRole("button", {
        name: englishMessages.clauses.leaveWithoutVersion,
      }),
    );
    expect(save.requests.at(0)?.write).toEqual({ body: B, expectedBody: A });
    expect(save.departures()).toBe(0);
    const failure = new Error("head write refused");
    await act(async () => {
      save.requests.at(0)?.deferred.reject(failure);
      await drain();
    });
    expect(save.errors).toEqual([failure]);
    expect(save.departures()).toBe(0);
    expect(save.head()).toEqual(A);
    expect(save.versions).toEqual([]);
    expect(save.view.getByLabelText("Version state").textContent).toBe("dirty");
  });
});
