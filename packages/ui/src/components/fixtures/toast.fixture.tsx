import { createRoot } from "react-dom/client";

import { Result, panic } from "better-result";

import { ToastProvider, stellaToast } from "../toast";

const REASON = `Anthropic: The complete provider rejection must remain available. ${"UnbrokenProviderDiagnostic".repeat(
  20,
)}`;
const DETAIL = `Request rejected.\n${"The complete provider response must remain available. ".repeat(
  12,
)}`;

const showRejectedPromiseToast = async () => {
  const result = await Result.tryPromise({
    try: async () =>
      stellaToast.promise(Promise.reject(new Error(REASON)), {
        loading: "Verifying",
        success: "Verified",
        error: () => ({ title: REASON, description: DETAIL }),
      }),
    catch: (error) => error,
  });
  if (Result.isOk(result) || !(result.error instanceof Error)) {
    panic("Expected rejected toast promise");
  }
  document.documentElement.dataset["promiseRejection"] = result.error.message;
};

const createErrorToasts = {
  error: () => stellaToast.error(REASON, { description: DETAIL }),
  add: () =>
    stellaToast.add({ title: REASON, description: DETAIL, type: "error" }),
  update: () => {
    const id = stellaToast.loading("Verifying");
    stellaToast.update(id, {
      title: REASON,
      description: DETAIL,
      type: "error",
    });
  },
  promise: () => {
    showRejectedPromiseToast().catch((error: unknown) => {
      document.documentElement.dataset["promiseFixtureError"] = String(error);
    });
  },
};

const timeoutUpdateCases = {
  "plain to described": { initial: {}, update: { description: DETAIL } },
  "plain to action": {
    initial: {},
    update: { action: { label: "Retry" } },
  },
  "described type patch": {
    initial: { description: DETAIL },
    update: { type: "error" },
  },
  "action type patch": {
    initial: { action: { label: "Retry" } },
    update: { type: "error" },
  },
  "clear description": {
    initial: { description: DETAIL },
    update: { description: null },
  },
  "clear action": {
    initial: { action: { label: "Retry" } },
    update: { action: undefined },
  },
  "clear action props": {
    initial: { actionProps: { children: "Retry" } },
    update: { actionProps: undefined },
  },
  "explicit eight second description": {
    initial: { timeout: 8000 },
    update: { description: DETAIL },
  },
  "explicit eight second title": {
    initial: { timeout: 8000 },
    update: { title: "Update failure" },
  },
  "explicit persistent type": {
    initial: { timeout: 0 },
    update: { type: "success" },
  },
  "explicit update wins": {
    initial: { timeout: 0, description: DETAIL },
    update: { timeout: 3000 },
  },
  "explicit infinity title": {
    initial: { timeout: Number.POSITIVE_INFINITY },
    update: { title: "Update failure" },
  },
} as const satisfies Record<
  string,
  {
    initial: NonNullable<Parameters<typeof stellaToast.error>[1]>;
    update: Parameters<typeof stellaToast.update>[1];
  }
>;

const requestedPosition = new URLSearchParams(window.location.search).get(
  "position",
);
const position =
  requestedPosition === "top-left" ||
  requestedPosition === "top-center" ||
  requestedPosition === "top-right" ||
  requestedPosition === "bottom-left" ||
  requestedPosition === "bottom-center"
    ? requestedPosition
    : "bottom-right";

const ToastFixture = () => (
  <ToastProvider position={position}>
    <main>
      {Object.entries(createErrorToasts).map(([entry, create]) => (
        <button
          type="button"
          key={entry}
          onClick={() => {
            create();
          }}
        >
          {entry}
        </button>
      ))}
      {Object.entries(timeoutUpdateCases).map(([name, { initial, update }]) => (
        <button
          type="button"
          key={name}
          onClick={() => {
            const id = stellaToast.error("Update failure", initial);
            stellaToast.update(id, update);
          }}
        >
          {name}
        </button>
      ))}
      <button
        type="button"
        onClick={() => {
          stellaToast.success("Successful request");
        }}
      >
        success
      </button>
      <button
        type="button"
        onClick={() => {
          stellaToast.error("Plain failure");
        }}
      >
        plain error
      </button>
    </main>
  </ToastProvider>
);

const rootElement = document.querySelector("#root");
if (!rootElement) {
  panic("Missing fixture root");
}
createRoot(rootElement).render(<ToastFixture />);
