import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import messages from "@/i18n/langs/en.json";

import type { PlaybookDraft } from "./playbook-editor.logic";
import type { SaveOutcome, SendSaveArgs } from "./use-playbook-save-queue";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { useState } = await import("react");
const { cleanup, fireEvent, render, act } =
  await import("@testing-library/react");
const { useMountEffect } = await import("@/hooks/use-effect");
const { useLatestCallback } = await import("@/hooks/use-latest-callback");
const { usePlaybookSaveQueue, usePlaybookDetailSaveSubscription } =
  await import("./use-playbook-save-queue");
const { QueryClient } = await import("@tanstack/react-query");
const { Input } = await import("@stll/ui/input");
const { knowledgeKeys } = await import("@/lib/knowledge/queries");

const initialDraft = {
  name: "Original",
  description: "",
  documentTypeKey: null,
  perspective: null,
  trigger: null,
  positions: [],
} satisfies PlaybookDraft;

type EditorHarnessProps = {
  sendSave: (args: SendSaveArgs) => Promise<SaveOutcome>;
  outcomes: SaveOutcome[];
  requests: Promise<unknown>[];
};

const EditorHarness = ({
  sendSave,
  outcomes,
  requests,
}: EditorHarnessProps) => {
  const [draft, setDraft] = useState(initialDraft);
  const [result, setResult] = useState("idle");
  const { queueSave, flushOnLeave } = usePlaybookSaveQueue({
    updatedAt: "2026-10-08T08:00:00.000Z",
    sendSave,
  });
  const save = () => {
    requests.push(
      queueSave(draft).then(({ outcome }) => {
        outcomes.push(outcome);
        setResult(outcome.type);
        return outcome;
      }),
    );
  };
  const leave = useLatestCallback(() => {
    const request = flushOnLeave({
      draft,
      isDirty: draft.name !== initialDraft.name,
      canSaveDraft: true,
    });
    requests.push(
      request.then((saved) => {
        if (saved === null) {
          return null;
        }
        outcomes.push(saved.outcome);
        return saved.outcome;
      }),
    );
  });
  useMountEffect(() => () => leave());
  return (
    <>
      <Input
        aria-label={messages.common.name}
        value={draft.name}
        onChange={(event) => setDraft({ ...draft, name: event.target.value })}
      />
      <button onClick={save} type="button">
        {messages.common.save}
      </button>
      <button onClick={save} type="button">
        {messages.common.retry}
      </button>
      <output>{result}</output>
    </>
  );
};

const deferred = () => {
  let complete: (outcome: SaveOutcome) => void = () => {
    throw new Error("Deferred response has not been initialized");
  };
  const promise = new Promise<SaveOutcome>((resolve) => {
    complete = resolve;
  });
  return { promise, complete };
};

const saved = {
  type: "saved",
  updatedAt: "2026-10-08T08:01:00.000Z",
} as const satisfies SaveOutcome;

afterEach(cleanup);
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

test("reverting and closing during a save persists the final draft after the response", async () => {
  const first = deferred();
  let persistedName = initialDraft.name;
  const sent: SendSaveArgs[] = [];
  const outcomes: SaveOutcome[] = [];
  const requests: Promise<unknown>[] = [];
  const view = render(
    <EditorHarness
      outcomes={outcomes}
      requests={requests}
      sendSave={async (args) => {
        sent.push(args);
        const outcome = sent.length === 1 ? await first.promise : saved;
        if (outcome.type === "saved") {
          persistedName = args.savedDraft.name;
        }
        return outcome;
      }}
    />,
  );
  fireEvent.change(view.getByLabelText(messages.common.name), {
    target: { value: "Edited" },
  });
  fireEvent.click(view.getByText(messages.common.save));
  expect(sent.at(0)?.savedDraft.name).toBe("Edited");
  fireEvent.change(view.getByLabelText(messages.common.name), {
    target: { value: "Original" },
  });
  view.unmount();
  expect(sent).toHaveLength(1);
  await act(async () => {
    first.complete(saved);
    await Promise.all(requests);
  });
  expect(sent).toHaveLength(2);
  expect(persistedName).toBe(initialDraft.name);
  expect(sent.at(1)).toMatchObject({
    savedDraft: { name: "Original" },
    expectedUpdatedAt: saved.updatedAt,
  });
  expect(outcomes.map((outcome) => outcome.type)).toEqual(["saved", "saved"]);
});

test("Retry saves after a rejected request and leaves no failed request in the queue", async () => {
  const sent: SendSaveArgs[] = [];
  const outcomes: SaveOutcome[] = [];
  const requests: Promise<unknown>[] = [];
  const view = render(
    <EditorHarness
      outcomes={outcomes}
      requests={requests}
      sendSave={async (args) => {
        sent.push(args);
        return sent.length === 1
          ? Promise.reject(new Error("Connection lost"))
          : Promise.resolve(saved);
      }}
    />,
  );
  fireEvent.click(view.getByText(messages.common.save));
  await act(async () => {
    await Promise.all(requests);
  });
  expect(view.getByText("failed")).toBeDefined();
  fireEvent.click(view.getByText(messages.common.retry));
  await act(async () => {
    await Promise.all(requests);
  });
  expect(sent).toHaveLength(2);
  expect(view.getByText("saved")).toBeDefined();
  view.unmount();
  await act(async () => {
    await Promise.all(requests);
  });
  expect(sent).toHaveLength(2);
  expect(outcomes.map((outcome) => outcome.type)).toEqual(["failed", "saved"]);
});

test("closing a dirty form flushes it without waiting for a debounce", async () => {
  const sent: SendSaveArgs[] = [];
  const outcomes: SaveOutcome[] = [];
  const requests: Promise<unknown>[] = [];
  const view = render(
    <EditorHarness
      outcomes={outcomes}
      requests={requests}
      sendSave={async (args) => {
        sent.push(args);
        return saved;
      }}
    />,
  );
  fireEvent.change(view.getByLabelText(messages.common.name), {
    target: { value: "Final draft" },
  });
  view.unmount();
  await act(async () => {
    await Promise.all(requests);
  });
  expect(sent.at(0)?.savedDraft.name).toBe("Final draft");
  expect(outcomes.map((outcome) => outcome.type)).toEqual(["saved"]);
});

test("a model save schedules work through the latest handler for the exact detail and stops on unmount", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity } },
  });
  const detailKey = knowledgeKeys.playbooks.detail("org", "same");
  client.setQueryData(detailKey, { status: "approved" });
  const scheduled: string[] = [];
  const DetailSubscriber = ({ phase }: { phase: string }) => {
    usePlaybookDetailSaveSubscription({
      queryClient: client,
      queryKey: detailKey,
      onSaved: () => {
        scheduled.push(phase);
      },
    });
    return null;
  };
  const view = render(<DetailSubscriber phase="idle" />);
  view.rerender(<DetailSubscriber phase="model-save" />);
  await act(async () => {
    client.setQueryData(knowledgeKeys.playbooks.detail("org", "other"), {
      status: "draft",
    });
    await client.invalidateQueries({
      queryKey: detailKey,
      exact: true,
      refetchType: "none",
    });
  });
  expect(scheduled).toEqual([]);
  await act(async () => {
    client.setQueryData(detailKey, { status: "draft" });
  });
  expect(scheduled).toEqual(["model-save"]);
  view.unmount();
  client.setQueryData(detailKey, { status: "draft", revision: 2 });
  expect(scheduled).toEqual(["model-save"]);
  client.clear();
});
