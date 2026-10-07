import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import {
  VISUAL_PREVIEW_LIMITS,
  visualPreviewInputSchema,
  visualPreviewOutputSchema,
  type VisualPreviewInput,
  type VisualPreviewOutput,
  type VisualPreviewToolOutput,
} from "@stll/api-contract/visual-preview";
import type { FailureReason } from "@stll/errors";
import { declareFailureClass } from "@stll/errors";

type VisualPreviewModelContentOptions = {
  title: string;
  preview: VisualPreviewOutput;
};

// Return the parts directly: wrapping them in an object makes the SDK serialize
// the PNG as JSON text instead of passing an image to the model.
export const visualPreviewModelContent = ({
  title,
  preview: { png, consoleErrors, blockedRequests, size, readyFired },
}: VisualPreviewModelContentOptions) =>
  [
    {
      type: "text",
      content: JSON.stringify({
        success: true,
        title,
        preview: { consoleErrors, blockedRequests, size, readyFired },
      }),
    },
    {
      type: "image",
      source: { type: "data", value: png, mimeType: "image/png" },
    },
  ] satisfies VisualPreviewToolOutput;

type PreviewFailureCode =
  | "not-configured"
  | "unavailable"
  | "timeout"
  | "invalid-input"
  | "invalid-response";

const PREVIEW_FAILURE_REASON = {
  "not-configured": "visual_preview_not_configured",
  "invalid-input": "visual_preview_input_invalid",
  unavailable: "visual_preview_unavailable",
  timeout: "visual_preview_timeout",
  "invalid-response": "visual_preview_response_invalid",
} as const satisfies Record<PreviewFailureCode, FailureReason>;

export class VisualPreviewError extends TaggedError("VisualPreviewError")<{
  code: PreviewFailureCode;
  message: string;
  cause?: unknown;
}> {
  static {
    declareFailureClass(this, ({ code }) => PREVIEW_FAILURE_REASON[code]);
  }
}

type VisualPreviewFailureModelContentOptions = {
  title: string;
  error: VisualPreviewError;
};

export const visualPreviewFailureModelContent = ({
  title,
  error,
}: VisualPreviewFailureModelContentOptions) =>
  [
    {
      type: "text",
      content: JSON.stringify({
        success: true,
        title,
        preview: {
          status: "unavailable",
          reason: error.code,
          message: error.message,
        },
      }),
    },
  ] satisfies VisualPreviewToolOutput;

type PreviewInvocation = {
  input: VisualPreviewInput;
  signal: AbortSignal;
};
type PreviewReply = {
  functionError?: string;
  payload?: Uint8Array;
};
type PreviewVisualOptions = {
  document: string;
  functionArn: string | undefined;
  invoke?: (invocation: PreviewInvocation) => Promise<PreviewReply>;
  timeoutMs?: number;
};

// SDK retries would multiply rendering work; each tool call gets one attempt.
const invokeLambda = async (
  functionArn: string,
  { input, signal }: PreviewInvocation,
) => {
  const client = new LambdaClient({ maxAttempts: 1 });
  const response = await client
    .send(
      new InvokeCommand({
        FunctionName: functionArn,
        InvocationType: "RequestResponse",
        Payload: new TextEncoder().encode(JSON.stringify(input)),
      }),
      { abortSignal: signal },
    )
    .finally(() => client.destroy());
  return {
    ...(response.FunctionError === undefined
      ? {}
      : { functionError: response.FunctionError }),
    ...(response.Payload === undefined ? {} : { payload: response.Payload }),
  };
};

export const previewVisual = async ({
  document,
  functionArn,
  invoke,
  timeoutMs = VISUAL_PREVIEW_LIMITS.invocationTimeoutMs,
}: PreviewVisualOptions) => {
  const parsed = v.safeParse(visualPreviewInputSchema, {
    document,
    viewport: { width: VISUAL_PREVIEW_LIMITS.width },
  });
  if (!parsed.success) {
    return Result.err(
      new VisualPreviewError({
        code: "invalid-input",
        message: "Visual preview input exceeds its bounds",
      }),
    );
  }
  if (functionArn === undefined) {
    return Result.err(
      new VisualPreviewError({
        code: "not-configured",
        message:
          "Visual preview is unavailable; the visual can still be published",
      }),
    );
  }
  const controller = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(() => {
      controller.abort();
      reject(
        new VisualPreviewError({
          code: "timeout",
          message:
            "Visual preview timed out; the visual can still be published",
        }),
      );
    }, timeoutMs);
  });
  const reply = await Result.tryPromise({
    try: async () =>
      Promise.race([
        invoke === undefined
          ? invokeLambda(functionArn, {
              input: parsed.output,
              signal: controller.signal,
            })
          : invoke({ input: parsed.output, signal: controller.signal }),
        expired,
      ]),
    catch: () =>
      new VisualPreviewError({
        code: controller.signal.aborted ? "timeout" : "unavailable",
        message: controller.signal.aborted
          ? "Visual preview timed out; the visual can still be published"
          : "Visual preview is unavailable; the visual can still be published",
      }),
  });
  clearTimeout(deadline);
  if (Result.isError(reply)) {
    return reply;
  }
  if (
    reply.value.functionError !== undefined ||
    reply.value.payload === undefined
  ) {
    return Result.err(
      new VisualPreviewError({
        code: "unavailable",
        message: "Visual preview failed; the visual can still be published",
      }),
    );
  }
  // Reject oversized replies before parsing or copying their JSON payload.
  const maxReplyBytes =
    VISUAL_PREVIEW_LIMITS.pngBase64Chars +
    VISUAL_PREVIEW_LIMITS.consoleErrors * VISUAL_PREVIEW_LIMITS.errorChars * 6 +
    1024;
  if (reply.value.payload.byteLength > maxReplyBytes) {
    return Result.err(
      new VisualPreviewError({
        code: "invalid-response",
        message: "Visual preview returned an invalid response",
      }),
    );
  }
  const decoded = Result.try((): unknown =>
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(reply.value.payload),
    ),
  );
  if (Result.isError(decoded)) {
    return Result.err(
      new VisualPreviewError({
        code: "invalid-response",
        message: "Visual preview returned an invalid response",
      }),
    );
  }
  const output = v.safeParse(visualPreviewOutputSchema, decoded.value);
  if (!output.success) {
    return Result.err(
      new VisualPreviewError({
        code: "invalid-response",
        message: "Visual preview returned an invalid response",
      }),
    );
  }
  return Result.ok(output.output);
};
