import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { Result } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

import { createTestState } from "../../../../../api/src/tests/helpers/test-state";
import type { AnswerEditProposal } from "./answer-edit-api";

GlobalRegistrator.register({ url: "https://app.example.test/chat/thread" });
const testState = createTestState({ file: import.meta.path, config: {} });
testState.setEnv(
  "VITE_API_URL",
  process.env["VITE_API_URL"] ?? "https://api.example.test",
);
const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { AnswerEditPanel } = await import("./answer-edit-panel");
const { APIError } = await import("@/lib/errors/api");

const anchor = {
  messageId: "message-1",
  baseRevision: 2,
  start: 7,
  end: 15,
  selectedSource: "old text",
};
const proposal = {
  replacement: "new text",
  content: {
    version: 3,
    data: [{ type: "text", content: "prefix new text suffix" }],
  },
  edit: {
    type: "ai_span",
    start: 7,
    end: 15,
    instruction: "Make this clearer",
    model: "fixture",
    keySource: "instance",
  },
} as const satisfies AnswerEditProposal;

afterEach(async () => {
  await act(async () => cleanup());
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

test("asks for instructions, previews the exact span diff and accepts the anchored revision", async () => {
  const requests: unknown[] = [];
  const saves: unknown[] = [];
  let refreshed = 0;
  let cancelled = 0;
  const view = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <AnswerEditPanel
        anchor={anchor}
        threadId="thread-1"
        disabled={false}
        onCancel={() => {
          cancelled++;
        }}
        onAnswerEdited={async () => {
          refreshed++;
        }}
        request={async (...args) => {
          requests.push(args);
          return Result.ok(proposal);
        }}
        accept={async (...args) => {
          saves.push(args);
          return Result.ok({ revision: 3, edited: true });
        }}
      />
    </IntlProvider>,
  );
  fireEvent.click(view.getByRole("button", { name: "Request change" }));
  await waitFor(() =>
    expect(view.getByRole("alert").textContent).toContain("Describe how"),
  );
  expect(requests).toHaveLength(0);
  fireEvent.change(view.getByRole("textbox"), {
    target: { value: "Make this clearer" },
  });
  fireEvent.keyDown(view.getByRole("textbox"), { key: "Enter" });
  await waitFor(() => expect(view.getByText("Suggested change")).toBeTruthy());
  expect(requests).toEqual([
    [{ threadId: "thread-1", anchor, instruction: "Make this clearer" }],
  ]);
  expect(view.container.querySelector("del")?.textContent).toBe("old text");
  expect(view.container.querySelector("ins")?.textContent).toBe("new text");
  fireEvent.click(view.getByRole("button", { name: "Accept" }));
  await waitFor(() => expect(refreshed).toBe(1));
  expect(saves).toEqual([[{ threadId: "thread-1", anchor, proposal }]]);
  expect(cancelled).toBe(1);
});

test("undo discards a proposal and Escape cancels instructions without saving", async () => {
  let saves = 0;
  let cancelled = 0;
  const view = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <AnswerEditPanel
        anchor={anchor}
        threadId="thread-1"
        disabled={false}
        onCancel={() => {
          cancelled++;
        }}
        onAnswerEdited={async () => undefined}
        request={async () => Result.ok(proposal)}
        accept={async () => {
          saves++;
          return Result.ok({ revision: 3, edited: true });
        }}
      />
    </IntlProvider>,
  );
  fireEvent.keyDown(view.getByRole("textbox"), { key: "Escape" });
  expect(cancelled).toBe(1);
  fireEvent.change(view.getByRole("textbox"), {
    target: { value: "Make this clearer" },
  });
  fireEvent.keyDown(view.getByRole("textbox"), { key: "Enter" });
  await waitFor(() => expect(view.getByText("Suggested change")).toBeTruthy());
  fireEvent.click(view.getByRole("button", { name: "Undo" }));
  expect(cancelled).toBe(2);
  expect(saves).toBe(0);
});

test("a revision conflict refreshes the answer and asks for a new selection", async () => {
  let refreshed = 0;
  const view = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <AnswerEditPanel
        anchor={anchor}
        threadId="thread-1"
        disabled={false}
        onCancel={() => undefined}
        onAnswerEdited={async () => {
          refreshed++;
        }}
        request={async () =>
          Result.err(new APIError({ status: 409, message: "Changed" }))
        }
      />
    </IntlProvider>,
  );
  fireEvent.change(view.getByRole("textbox"), {
    target: { value: "Make this clearer" },
  });
  fireEvent.keyDown(view.getByRole("textbox"), { key: "Enter" });
  await waitFor(() =>
    expect(view.getByRole("alert").textContent).toContain(
      "Select the text again",
    ),
  );
  expect(refreshed).toBe(1);
  expect(view.queryByRole("button", { name: "Accept" })).toBeNull();
});

test("streaming disables submitting an edit", async () => {
  let requests = 0;
  const view = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <AnswerEditPanel
        anchor={anchor}
        threadId="thread-1"
        disabled
        onCancel={() => undefined}
        onAnswerEdited={async () => undefined}
        request={async () => {
          requests++;
          return Result.ok(proposal);
        }}
      />
    </IntlProvider>,
  );
  expect(view.getByRole("textbox").hasAttribute("disabled")).toBe(true);
  expect(
    view
      .getByRole("button", { name: "Request change" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.keyDown(view.getByRole("textbox"), { key: "Enter" });
  await act(async () => undefined);
  expect(requests).toBe(0);
});

test("Escape cancels a pending request after focus leaves the removed instruction input", async () => {
  let cancelled = 0;
  const view = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <AnswerEditPanel
        anchor={anchor}
        threadId="thread-1"
        disabled={false}
        onCancel={() => {
          cancelled++;
        }}
        onAnswerEdited={async () => undefined}
        request={() =>
          new Promise(() => {
            /* Keep the offline request pending until cancellation. */
          })
        }
      />
    </IntlProvider>,
  );
  fireEvent.change(view.getByRole("textbox"), {
    target: { value: "Make this clearer" },
  });
  fireEvent.keyDown(view.getByRole("textbox"), { key: "Enter" });
  await waitFor(() =>
    expect(view.getByRole("status").textContent).toContain("Preparing changes"),
  );
  const active = document.activeElement;
  if (active === null || active === document.body) {
    throw new TypeError("The pending panel must retain keyboard focus");
  }
  fireEvent.keyDown(active, { key: "Escape" });
  expect(cancelled).toBe(1);
});

test("acceptance keeps focus and ignores Escape while the revision write is pending", async () => {
  let cancelled = 0;
  const view = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <AnswerEditPanel
        anchor={anchor}
        threadId="thread-1"
        disabled={false}
        onCancel={() => {
          cancelled++;
        }}
        onAnswerEdited={async () => undefined}
        request={async () => Result.ok(proposal)}
        accept={() =>
          new Promise(() => {
            /* Keep the revision write pending while testing keyboard ownership. */
          })
        }
      />
    </IntlProvider>,
  );
  fireEvent.change(view.getByRole("textbox"), {
    target: { value: "Make this clearer" },
  });
  fireEvent.keyDown(view.getByRole("textbox"), { key: "Enter" });
  await waitFor(() => expect(view.getByText("Suggested change")).toBeTruthy());
  fireEvent.click(view.getByRole("button", { name: "Accept" }));
  await waitFor(() =>
    expect(
      view.getByRole("button", { name: "Accept" }).hasAttribute("disabled"),
    ).toBe(true),
  );
  const active = document.activeElement;
  if (active === null || active === document.body) {
    throw new TypeError("The accepting panel must retain keyboard focus");
  }
  fireEvent.keyDown(active, { key: "Escape" });
  expect(cancelled).toBe(0);
});

test("accepting a stale proposal refreshes the answer and removes the save action", async () => {
  let refreshed = 0;
  const view = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <AnswerEditPanel
        anchor={anchor}
        threadId="thread-1"
        disabled={false}
        onCancel={() => undefined}
        onAnswerEdited={async () => {
          refreshed++;
        }}
        request={async () => Result.ok(proposal)}
        accept={async () =>
          Result.err(new APIError({ status: 409, message: "Changed" }))
        }
      />
    </IntlProvider>,
  );
  fireEvent.change(view.getByRole("textbox"), {
    target: { value: "Make this clearer" },
  });
  fireEvent.keyDown(view.getByRole("textbox"), { key: "Enter" });
  await waitFor(() => expect(view.getByText("Suggested change")).toBeTruthy());
  fireEvent.click(view.getByRole("button", { name: "Accept" }));
  await waitFor(() =>
    expect(view.getByRole("alert").textContent).toContain(
      "Select the text again",
    ),
  );
  expect(refreshed).toBe(1);
  expect(view.queryByRole("button", { name: "Accept" })).toBeNull();
});
