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

const ToastFixture = () => (
  <ToastProvider>
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
      <button
        type="button"
        onClick={() => {
          stellaToast.success("Successful request");
        }}
      >
        success
      </button>
    </main>
  </ToastProvider>
);

const rootElement = document.querySelector("#root");
if (!rootElement) {
  panic("Missing fixture root");
}
createRoot(rootElement).render(<ToastFixture />);
