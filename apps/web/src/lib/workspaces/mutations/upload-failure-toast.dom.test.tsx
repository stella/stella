import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register();
const { act } = await import("react");
const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { ToastProvider, stellaToast } = await import("@stll/ui/toast");
const { toAPIError } = await import("@/lib/errors/api");
const { readQueryResult } = await import("@/lib/errors/query-result");
const { ACTION_ADMISSION_CODES, ACTION_ADMISSION_REFUSALS } =
  await import("@stll/api-contract/action-admission");
const messages = (await import("@/i18n/langs/en.json")).default;
const { showUploadFailureToast } = await import("./upload-failure-toast");

afterEach(async () => {
  await act(async () => stellaToast.dismiss());
  cleanup();
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

test("permanent rejections show each safe reason without a Retry action", async () => {
  const view = render(<ToastProvider />);
  let toastId = "";
  const failures = [
    ["contract.exe", 415],
    ["archive.zip", 413],
    ["duplicate.pdf", 409],
    ["private.pdf", 403],
  ].map(([name, status]) => ({
    file: new File(["x"], String(name)),
    error: toAPIError({
      status: Number(status),
      value: { message: `Private server detail for ${String(name)}` },
    }),
    disposition: "permanent" as const,
  }));

  await act(async () => {
    toastId = stellaToast.loading("Uploading");
    showUploadFailureToast({
      toastId,
      title: "Upload failed",
      type: "error",
      failures,
      labels: {
        reasonFallback: "Upload failed",
        additionalFailures: (count) => `and ${String(count)} more`,
        retryFailed: (count) => `Retry ${String(count)} files`,
      },
      onRetry: () => {
        throw new Error("permanent files must not be retried");
      },
    });
    await sleep(20);
  });

  expect(view.getByText("contract.exe").parentElement?.textContent).toContain(
    "request failed",
  );
  expect(view.getByText("archive.zip").parentElement?.textContent).toContain(
    "too large",
  );
  expect(view.queryByText("private.pdf")).toBeNull();
  expect(view.queryByRole("button", { name: /Retry/u })).toBeNull();
  expect(view.queryByText(/Private server detail/u)).toBeNull();

  await act(async () => {
    fireEvent.click(view.getByText("and 1 more"));
  });
  expect(view.getByText("private.pdf").parentElement?.textContent).toContain(
    "permission",
  );
});

test("a mixed upload batch explains an empty file without presigning or retrying it", async () => {
  const { UploadQueue } = await import("@/lib/upload-queue");
  const { EmptyUploadFileError } =
    await import("@/lib/files/upload-file-validation");
  const { buildEntityCreatePresignPayload } =
    await import("./create-file-upload-payload.logic");
  const presignedNames: string[] = [];
  const queue = new UploadQueue(async (file) => {
    const payload = readQueryResult(
      buildEntityCreatePresignPayload({
        propertyId: "property_upload",
        name: file.name,
        mimeType: file.type,
        size: file.size,
        sha256Hex: "a".repeat(64),
      }),
    );
    presignedNames.push(payload.name);
    if (file.name === "wrong.pdf") {
      throw toAPIError({
        status: 422,
        value: {
          code: "file_security_rejected",
          message: "File rejected by security check",
        },
      });
    }
    return file.name;
  });
  const finished = new Promise<void>((resolve) => {
    queue.on("done", () => resolve());
  });
  queue.enqueue([
    new File([], "empty.pdf", { type: "application/pdf" }),
    new File(["wrong content"], "wrong.pdf", { type: "application/pdf" }),
    new File(["content"], "accepted.pdf", { type: "application/pdf" }),
  ]);
  await finished;

  expect(presignedNames).toEqual(["wrong.pdf", "accepted.pdf"]);
  expect(queue.getProgress()).toEqual({ completed: 1, failed: 2, total: 3 });
  expect(
    queue.getFailedFiles().some(({ error }) => EmptyUploadFileError.is(error)),
  ).toBe(true);
  expect(
    queue
      .getFailedFiles()
      .every(({ disposition }) => disposition === "permanent"),
  ).toBe(true);

  const view = render(<ToastProvider />);
  await act(async () => {
    showUploadFailureToast({
      toastId: stellaToast.loading("Uploading"),
      title: "Some uploads failed",
      type: "warning",
      failures: queue.getFailedFiles(),
      labels: {
        reasonFallback: "Upload failed",
        additionalFailures: (count) => `and ${String(count)} more`,
        retryFailed: (count) => `Retry ${String(count)} files`,
      },
      onRetry: () => queue.retryFailed(),
    });
    await sleep(20);
  });

  expect(view.getByText("empty.pdf").parentElement?.textContent).toContain(
    messages.workspaces.files.emptyFile,
  );
  expect(view.getByText("wrong.pdf").parentElement?.textContent).toContain(
    messages.errors.apiCodes.fileSecurityRejected,
  );
  expect(view.queryByRole("button", { name: /Retry/u })).toBeNull();
  queue.retryFailed();
  expect(presignedNames).toEqual(["wrong.pdf", "accepted.pdf"]);
});

test("a batch refused only by action admission keeps the refusal notice", async () => {
  const view = render(<ToastProvider />);
  const code = ACTION_ADMISSION_CODES.periodExhausted;
  const failures = ["first.pdf", "second.pdf"].map((name) => ({
    file: new File(["x"], name),
    error: toAPIError({
      status: ACTION_ADMISSION_REFUSALS[code].status,
      value: { code, message: "Internal details" },
    }),
    disposition: "permanent" as const,
  }));

  await act(async () => {
    showUploadFailureToast({
      toastId: stellaToast.loading("Uploading"),
      title: "Upload failed",
      type: "error",
      failures,
      labels: {
        reasonFallback: "Upload failed",
        additionalFailures: (count) => `and ${String(count)} more`,
        retryFailed: (count) => `Retry ${String(count)} files`,
      },
      onRetry: () => {
        throw new Error("refused files must not be retried");
      },
    });
    await sleep(20);
  });

  const refusalMessages = Object.values(messages.errors.actionAdmission);
  expect(
    refusalMessages.some((message) => view.queryByText(message) !== null),
  ).toBe(true);
  expect(view.queryByText("first.pdf")).toBeNull();
  expect(view.queryByText(/Internal details/u)).toBeNull();
});

test("same-named files from different folders each keep their own row", async () => {
  const view = render(<ToastProvider />);
  const failures = [415, 413].map((status) => ({
    file: new File(["x"], "contract.pdf"),
    error: toAPIError({ status, value: { message: "Private detail" } }),
    disposition: "permanent" as const,
  }));

  await act(async () => {
    showUploadFailureToast({
      toastId: stellaToast.loading("Uploading"),
      title: "Upload failed",
      type: "error",
      failures,
      labels: {
        reasonFallback: "Upload failed",
        additionalFailures: (count) => `and ${String(count)} more`,
        retryFailed: (count) => `Retry ${String(count)} files`,
      },
      onRetry: () => undefined,
    });
    await sleep(20);
  });

  const rows = view.getAllByText("contract.pdf");
  expect(rows).toHaveLength(2);
  expect(rows[0]?.parentElement?.textContent).toContain("request failed");
  expect(rows[1]?.parentElement?.textContent).toContain("too large");
});
