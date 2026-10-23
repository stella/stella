declare const withTimeout: (
  operation: () => Promise<void>,
  options: { label: string; timeoutMs: number },
) => Promise<void>;

const id = "record-1";

void withTimeout(async () => await Promise.resolve(), {
  // oxlint-disable-next-line require-static-timeout-label/require-static-timeout-label -- fixture proves substitutions are rejected
  label: `record-${id}`,
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
