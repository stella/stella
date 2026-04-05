import type {
  OnStepFinishEvent,
  OnStepStartEvent,
  OnToolCallFinishEvent,
  StreamTextOnErrorCallback,
} from "ai";

import { env } from "@/api/env";
import { errorTag } from "@/api/lib/errors/utils";

import { getAnalytics, isLocalPostHogDebugEnabled } from "./index";
import type { Analytics } from "./types";

type AnalyticsPrimitive = boolean | number | string;

type AnalyticsMetadata = Record<string, AnalyticsPrimitive>;

type AnalyticsStepState = {
  input: unknown[] | undefined;
  modelId: string;
  provider: string;
  spanId: string;
  startedAt: number;
};

type AIAnalyticsProps = {
  feature: string;
  traceId: string;
  sessionId?: string;
  distinctId?: string;
  properties?: AnalyticsMetadata;
  analytics?: Analytics;
  captureContent?: boolean;
  forceEnabled?: boolean;
};

const MAX_STRING_LENGTH = 2000;
const TRUNCATION_MARKER = " [truncated]";
const ONE_SECOND_MS = 1000;
const noop = () => void 0;

const truncateString = (value: string): string => {
  if (value.length <= MAX_STRING_LENGTH) {
    return value;
  }

  return (
    value.slice(0, MAX_STRING_LENGTH - TRUNCATION_MARKER.length) +
    TRUNCATION_MARKER
  );
};

export const sanitizeForAIAnalytics = (value: unknown): unknown => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }

  if (typeof value === "string") {
    return truncateString(value);
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof ArrayBuffer) {
    return `[binary:${value.byteLength} bytes]`;
  }

  if (ArrayBuffer.isView(value)) {
    return `[binary:${value.byteLength} bytes]`;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForAIAnalytics(item));
  }

  if (typeof value === "object") {
    const entries = Object.entries(value);
    return Object.fromEntries(
      entries.map(([key, entryValue]) => [
        key,
        key === "data" &&
        (entryValue instanceof ArrayBuffer || ArrayBuffer.isView(entryValue))
          ? "[binary]"
          : sanitizeForAIAnalytics(entryValue),
      ]),
    );
  }

  const serialized = JSON.stringify(value);
  return serialized ?? Object.prototype.toString.call(value);
};

const normalizeProvider = (provider: string): string => {
  if (provider.startsWith("google")) {
    return "gemini";
  }

  return provider;
};

const normalizeMessageRole = (
  role: string,
): "assistant" | "system" | "user" | null => {
  if (role === "assistant" || role === "system" || role === "user") {
    return role;
  }

  return null;
};

const serializeMessages = (
  messages: readonly { content: unknown; role: string }[],
): unknown[] =>
  messages
    .map((message) => {
      const role = normalizeMessageRole(message.role);
      if (!role) {
        return null;
      }

      return {
        role,
        content: sanitizeForAIAnalytics(message.content),
      };
    })
    .filter((message) => message !== null);

const serializeToolNames = (
  toolCalls: readonly { toolName: string }[],
): string[] => [...new Set(toolCalls.map((toolCall) => toolCall.toolName))];

const getErrorPayload = ({
  error,
  captureContent,
}: {
  error: unknown;
  captureContent: boolean;
}): string | { message: unknown; type: string } =>
  captureContent && error instanceof Error
    ? {
        message: sanitizeForAIAnalytics(error.message),
        type: error.constructor.name,
      }
    : errorTag(error);

const buildBaseProperties = ({
  config,
  captureContent,
  spanId,
}: {
  config: AIAnalyticsProps;
  captureContent: boolean;
  spanId: string;
}) => ({
  $ai_trace_id: config.traceId,
  ...(config.sessionId ? { $ai_session_id: config.sessionId } : {}),
  $ai_span_id: spanId,
  $ai_span_name: config.feature,
  ...(captureContent ? { debug_mode: true } : {}),
  ...config.properties,
});

type AIAnalyticsStepCallbacks = {
  experimental_onStepStart?: (event: OnStepStartEvent) => void;
  onStepFinish?: (event: OnStepFinishEvent) => void;
  experimental_onToolCallFinish?: (event: OnToolCallFinishEvent) => void;
};

type AIAnalyticsCallbacks = {
  stepCallbacks: AIAnalyticsStepCallbacks;
  onStreamError?: StreamTextOnErrorCallback;
  captureError: (error: unknown) => void;
};

export const createAIAnalyticsCallbacks = ({
  analytics = getAnalytics(),
  captureContent = env.POSTHOG_LOCAL_DEBUG_AI_CONTENT,
  forceEnabled = false,
  ...config
}: AIAnalyticsProps): AIAnalyticsCallbacks => {
  if (!forceEnabled && !isLocalPostHogDebugEnabled()) {
    return {
      stepCallbacks: {},
      captureError: noop,
    };
  }

  const stepState = new Map<number, AnalyticsStepState>();
  const distinctId = config.distinctId ?? `local-debug:${config.feature}`;
  let hasCapturedGenerationError = false;

  const onStepStart: NonNullable<
    AIAnalyticsStepCallbacks["experimental_onStepStart"]
  > = ({ messages, model, stepNumber }) => {
    stepState.set(stepNumber, {
      input: captureContent ? serializeMessages(messages) : undefined,
      modelId: model.modelId,
      provider: normalizeProvider(model.provider),
      spanId: crypto.randomUUID(),
      startedAt: performance.now(),
    });
  };

  const onStepFinish: NonNullable<AIAnalyticsStepCallbacks["onStepFinish"]> = ({
    model,
    response,
    stepNumber,
    toolCalls,
    usage,
  }) => {
    const currentStep =
      stepState.get(stepNumber) ??
      ({
        input: undefined,
        modelId: model.modelId,
        provider: normalizeProvider(model.provider),
        spanId: crypto.randomUUID(),
        startedAt: performance.now(),
      } satisfies AnalyticsStepState);

    analytics.capture({
      distinctId,
      event: "$ai_generation",
      properties: {
        ...buildBaseProperties({
          config,
          captureContent,
          spanId: currentStep.spanId,
        }),
        $ai_input_tokens: usage.inputTokens,
        $ai_output_tokens: usage.outputTokens,
        $ai_latency:
          (performance.now() - currentStep.startedAt) / ONE_SECOND_MS,
        $ai_model: currentStep.modelId,
        $ai_provider: currentStep.provider,
        ...(toolCalls.length > 0
          ? { $ai_tools: serializeToolNames(toolCalls) }
          : {}),
        ...(captureContent && currentStep.input
          ? { $ai_input: currentStep.input }
          : {}),
        ...(captureContent
          ? { $ai_output_choices: serializeMessages(response.messages) }
          : {}),
      },
    });

    stepState.delete(stepNumber);
  };

  const onToolCallFinish: NonNullable<
    AIAnalyticsStepCallbacks["experimental_onToolCallFinish"]
  > = (event) => {
    const parentStep =
      event.stepNumber === undefined
        ? undefined
        : stepState.get(event.stepNumber);

    analytics.capture({
      distinctId,
      event: "$ai_span",
      properties: {
        $ai_trace_id: config.traceId,
        ...(config.sessionId ? { $ai_session_id: config.sessionId } : {}),
        $ai_span_id: crypto.randomUUID(),
        $ai_span_name: event.toolCall.toolName,
        ...(parentStep ? { $ai_parent_id: parentStep.spanId } : {}),
        $ai_latency: event.durationMs / ONE_SECOND_MS,
        ...(captureContent
          ? {
              $ai_input_state: sanitizeForAIAnalytics({
                tool: event.toolCall.toolName,
                input: event.toolCall.input,
              }),
              ...(event.success
                ? {
                    $ai_output_state: sanitizeForAIAnalytics(event.output),
                  }
                : {}),
            }
          : {}),
        ...(event.success
          ? {}
          : {
              $ai_is_error: true,
              $ai_error: getErrorPayload({
                error: event.error,
                captureContent,
              }),
            }),
        ...config.properties,
      },
    });
  };

  const stepCallbacks: AIAnalyticsStepCallbacks = {
    experimental_onStepStart: onStepStart,
    onStepFinish,
    experimental_onToolCallFinish: onToolCallFinish,
  };

  const captureGenerationError = (error: unknown) => {
    if (hasCapturedGenerationError) {
      return;
    }

    hasCapturedGenerationError = true;
    const activeStep = [...stepState.values()].at(-1);

    analytics.capture({
      distinctId,
      event: "$ai_generation",
      properties: {
        ...buildBaseProperties({
          config,
          captureContent,
          spanId: activeStep?.spanId ?? crypto.randomUUID(),
        }),
        $ai_is_error: true,
        $ai_error: getErrorPayload({ error, captureContent }),
        ...(activeStep
          ? {
              ...(captureContent && activeStep.input
                ? { $ai_input: activeStep.input }
                : {}),
              $ai_latency:
                (performance.now() - activeStep.startedAt) / ONE_SECOND_MS,
              $ai_model: activeStep.modelId,
              $ai_provider: activeStep.provider,
            }
          : {}),
      },
    });
  };

  return {
    stepCallbacks,
    onStreamError: ({ error }: { error: unknown }) => {
      captureGenerationError(error);
    },
    captureError: captureGenerationError,
  };
};
