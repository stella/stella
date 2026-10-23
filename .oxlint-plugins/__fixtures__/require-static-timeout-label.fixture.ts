import { DOCUMENT_FETCH_EVENT as IMPORTED_LABELS } from "../../packages/legal-atlas/src/document-fetch-diagnostics.ts";

declare const withTimeout: (
  operation: () => Promise<void>,
  options: { label: string; timeoutMs: number },
) => Promise<void>;

const id = "record-1";

const CLOSED_LABELS = {
  read: "record-read",
  write: "record-write",
} as const satisfies Record<"read" | "write", string>;
const key: keyof typeof CLOSED_LABELS = "write";

const NON_LITERAL_LABELS = { read: id } as const;
// oxlint-disable-next-line prefer-const -- fixture proves mutable bindings are rejected
let LET_LABELS = { read: "record-read" } as const;

const functionLocalLabel = () => {
  const LOCAL_LABELS = { read: "record-read" } as const;
  void withTimeout(async () => await Promise.resolve(), {
    // oxlint-disable-next-line require-static-timeout-label/require-static-timeout-label -- fixture proves function-local tables are rejected
    label: LOCAL_LABELS.read,
    timeoutMs: 10,
  });
};
void functionLocalLabel;

void withTimeout(async () => await Promise.resolve(), {
  // oxlint-disable-next-line require-static-timeout-label/require-static-timeout-label -- fixture proves substitutions are rejected
  label: `record-${id}`,
  timeoutMs: 10,
});

void withTimeout(async () => await Promise.resolve(), {
  // expect-clean: require-static-timeout-label/require-static-timeout-label
  label: CLOSED_LABELS.read,
  timeoutMs: 10,
});

void withTimeout(async () => await Promise.resolve(), {
  // expect-clean: require-static-timeout-label/require-static-timeout-label
  label: CLOSED_LABELS[key],
  timeoutMs: 10,
});

void withTimeout(async () => await Promise.resolve(), {
  // oxlint-disable-next-line require-static-timeout-label/require-static-timeout-label -- fixture proves non-literal table values are rejected
  label: NON_LITERAL_LABELS.read,
  timeoutMs: 10,
});

void withTimeout(async () => await Promise.resolve(), {
  // oxlint-disable-next-line require-static-timeout-label/require-static-timeout-label -- fixture proves let tables are rejected
  label: LET_LABELS.read,
  timeoutMs: 10,
});

void withTimeout(async () => await Promise.resolve(), {
  // oxlint-disable-next-line require-static-timeout-label/require-static-timeout-label -- fixture proves imported tables are rejected
  label: IMPORTED_LABELS.observerFailed,
  timeoutMs: 10,
});

void withTimeout(async () => await Promise.resolve(), {
  // oxlint-disable-next-line require-static-timeout-label/require-static-timeout-label -- fixture proves non-literal expressions are rejected
  label: id,
  timeoutMs: 10,
});

void withTimeout(async () => await Promise.resolve(), {
  // expect-clean: require-static-timeout-label/require-static-timeout-label
  label: "record-read",
  timeoutMs: 10,
});
