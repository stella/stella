import { useState } from "react";

import { stellaToast } from "@stll/ui/toast";

import { actionAdmissionOutcome } from "@/lib/errors/action-admission";
import { APIError } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { notifyUserError } from "@/lib/errors/user-toast";
import type { FailedUpload } from "@/lib/upload-queue";

const MAX_DISPLAYED_FAILURES = 3;

type UploadFailureToastLabels = {
  reasonFallback: string;
  additionalFailures: (count: number) => string;
  retryFailed: (count: number) => string;
};

type ShowUploadFailureToastOptions = {
  toastId: string;
  title: string;
  type: "error" | "warning";
  failures: FailedUpload[];
  labels: UploadFailureToastLabels;
  onRetry: () => void;
};

export const showUploadFailureToast = ({
  toastId,
  title,
  type,
  failures,
  labels,
  onRetry,
}: ShowUploadFailureToastOptions): void => {
  const retryableCount = failures.filter(
    ({ disposition }) => disposition === "retryable",
  ).length;
  const options = {
    description: (
      <UploadFailureDescription failures={failures} labels={labels} />
    ),
    timeout: 0,
    actionProps:
      retryableCount === 0
        ? undefined
        : {
            children: labels.retryFailed(retryableCount),
            onClick: onRetry,
          },
  };
  if (type === "error") {
    // A batch refused only by action admission keeps the refusal notice that
    // notifyUserError shows for it; any other failure lists the files.
    const refusal = failures.every(
      ({ error }) => actionAdmissionOutcome(error) !== undefined,
    )
      ? failures.at(0)?.error
      : undefined;
    notifyUserError(refusal, title, { toastId, ...options });
    return;
  }
  stellaToast.update(toastId, { type: "warning", title, ...options });
};

const UploadFailureDescription = ({
  failures,
  labels,
}: {
  failures: FailedUpload[];
  labels: UploadFailureToastLabels;
}) => {
  const [showAll, setShowAll] = useState(false);
  const visible = failures.slice(0, MAX_DISPLAYED_FAILURES);
  const hidden = failures.slice(MAX_DISPLAYED_FAILURES);
  return (
    <span className="block">
      <FailureList failures={visible} fallback={labels.reasonFallback} />
      {hidden.length > 0 && (
        <span className="block">
          {!showAll && (
            <button
              className="cursor-pointer underline select-none"
              onClick={() => setShowAll(true)}
              type="button"
            >
              {labels.additionalFailures(hidden.length)}
            </button>
          )}
          {showAll && (
            <FailureList failures={hidden} fallback={labels.reasonFallback} />
          )}
        </span>
      )}
    </span>
  );
};

// Files from different dropped folders can share a name; the File object is
// the row's identity.
const failureRowKeys = new WeakMap<File, string>();
let nextFailureRowKey = 0;
const failureRowKey = (file: File): string => {
  const known = failureRowKeys.get(file);
  if (known !== undefined) {
    return known;
  }
  nextFailureRowKey += 1;
  const key = `upload-failure-${String(nextFailureRowKey)}`;
  failureRowKeys.set(file, key);
  return key;
};

const FailureList = ({
  failures,
  fallback,
}: {
  failures: FailedUpload[];
  fallback: string;
}) => (
  <span className="block">
    {failures.map(({ file, error }) => (
      <span className="block" key={failureRowKey(file)}>
        <bdi>{file.name}</bdi>: {failureReason(error, fallback)}
      </span>
    ))}
  </span>
);

const failureReason = (error: Error, fallback: string): string =>
  APIError.is(error) ? error.message : userErrorFromThrown(error, fallback);
