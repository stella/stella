import { panic } from "better-result";
import { expect } from "bun:test";

import type { OrgAIConfigReadFailure } from "@/api/lib/ai-config-crypto";
import { storedAIConfigUnreadableError } from "@/api/lib/ai-config-response";
import type {
  OrganizationGroupIdentifyParams,
  ServerAnalyticsCaptureParams,
} from "@/api/lib/analytics/server-analytics";
import type { SafeId } from "@/api/lib/branded-types";
import { sanitizeDiagnosticErrorForOutput } from "@/api/lib/errors/handoff-diagnostics";
import { serializeDevError } from "@/api/lib/errors/utils";
import type { LogRecord } from "@/api/lib/observability/logger";

type SettingsFailureOutputs = {
  analyticsEvents: readonly ServerAnalyticsCaptureParams[];
  captureEntries: readonly unknown[];
  developmentEntries: readonly unknown[];
  developmentLogInputs?: readonly unknown[];
  developmentJsonlEntries?: readonly unknown[];
  trustedDevelopmentStack?: string;
  groupIdentifies: readonly OrganizationGroupIdentifyParams[];
  logRecords: readonly LogRecord[];
  returned: unknown;
};

const compareKeys = (left: PropertyKey, right: PropertyKey): number => {
  const leftKey = String(left);
  const rightKey = String(right);
  if (leftKey < rightKey) {
    return -1;
  }
  if (leftKey > rightKey) {
    return 1;
  }
  return 0;
};

type DescriptorNode =
  | { type: "primitive"; value: unknown }
  | {
      type: "object";
      properties: Record<
        string,
        {
          configurable: boolean;
          enumerable: boolean;
          writable?: boolean;
          value?: DescriptorNode;
        }
      >;
    };

/**
 * Snapshot every own property, including non-enumerable error fields. This is
 * intentionally descriptor based: JSON.stringify misses Error causes, symbol
 * properties, and values hidden by a custom toJSON implementation.
 */
const descriptorGraph = (
  value: unknown,
  seen = new Set<object>(),
): DescriptorNode => {
  if ((typeof value !== "object" && typeof value !== "function") || !value) {
    return { type: "primitive", value };
  }
  if (seen.has(value)) {
    return { type: "primitive", value: "[cycle]" };
  }
  seen.add(value);
  const properties: DescriptorNode & { type: "object" } = {
    type: "object",
    properties: {},
  };
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor) {
      continue;
    }
    properties.properties[String(key)] = {
      configurable: descriptor.configurable ?? false,
      enumerable: descriptor.enumerable ?? false,
      ...(Object.hasOwn(descriptor, "writable")
        ? { writable: descriptor.writable ?? false }
        : {}),
      ...(Object.hasOwn(descriptor, "value")
        ? { value: descriptorGraph(descriptor.value, seen) }
        : {}),
    };
  }
  return properties;
};

const SOURCE_LOCATION_KEYS = new Set<PropertyKey>([
  "column",
  "line",
  "originalColumn",
  "originalLine",
  "sourceURL",
  "stack",
]);

const errorPayload = (error: Error): Record<string, unknown> =>
  Object.fromEntries(
    Reflect.ownKeys(error)
      .filter((key) => typeof key === "string")
      .filter((key) => !SOURCE_LOCATION_KEYS.has(key))
      .map((key) => [key, Reflect.get(error, key)]),
  );

export const assertCanonicalStoredAIConfigError = (error: unknown): void => {
  if (!(error instanceof Error)) {
    panic("Expected the stored AI config public error");
  }
  const canonical = storedAIConfigUnreadableError();
  expect(Reflect.ownKeys(error).toSorted(compareKeys)).toEqual(
    Reflect.ownKeys(canonical).toSorted(compareKeys),
  );
  expect(errorPayload(error)).toStrictEqual(errorPayload(canonical));
};

const REPOSITORY_PATH = "(?:apps|packages)/[A-Za-z0-9_./-]+\\.ts";
const REPOSITORY_ROOT = import.meta.dir.replace(
  /apps\/api\/src\/tests\/helpers$/u,
  "",
);
const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const REPOSITORY_SOURCE = new RegExp(
  `^${escapeRegExp(REPOSITORY_ROOT)}${REPOSITORY_PATH}$`,
  "u",
);
const REPOSITORY_FRAME = new RegExp(
  `^(?:${escapeRegExp(REPOSITORY_ROOT)})?${REPOSITORY_PATH}:\\d+:\\d+$`,
  "u",
);
const STACK_FUNCTION = "(?:async )?(?:[A-Za-z_$][A-Za-z0-9_$.<>]*|<anonymous>)";
const BETTER_RESULT_SOURCE = new URL(import.meta.resolve("better-result"))
  .pathname;
const STACK_LOCATION = `(?:${REPOSITORY_SOURCE.source.slice(1, -1)}|${escapeRegExp(BETTER_RESULT_SOURCE)}):\\d+:\\d+`;
const STACK_FRAME = new RegExp(
  `^ {4}at ${STACK_FUNCTION} (?:\\(${STACK_LOCATION}\\)|${STACK_LOCATION})$`,
  "u",
);

const reflectedValue = (object: object, key: PropertyKey): unknown =>
  Reflect.get(object, key);

const assertSourceLocations = (error: Error): void => {
  const sourceURL = reflectedValue(error, "sourceURL");
  const stack = reflectedValue(error, "stack");
  expect(sourceURL).toBeString();
  expect(sourceURL).toMatch(REPOSITORY_SOURCE);
  if (typeof stack !== "string") {
    panic("Expected an error stack");
  }
  const lines = stack.split("\n");
  const tag = reflectedValue(error, "_tag");
  const stackName = typeof tag === "string" ? tag : error.name;
  expect(lines.at(0)).toBe(`${stackName}: ${error.message}`);
  expect(lines.length).toBeGreaterThan(1);
  for (const frame of lines.slice(1)) {
    expect(frame === "    at unknown" || STACK_FRAME.test(frame)).toBe(true);
  }
  for (const key of ["line", "column", "originalLine", "originalColumn"]) {
    const value = reflectedValue(error, key);
    expect(
      value === undefined ||
        (typeof value === "number" && Number.isInteger(value) && value >= 0),
    ).toBe(true);
  }
};

const normalizeFrame = (value: unknown): unknown => {
  if (typeof value !== "string") {
    panic("Expected a source frame");
  }
  expect(value).toMatch(REPOSITORY_FRAME);
  return value.replace(/:\d+:\d+$/u, ":[line]:[column]");
};

const normalizeStack = (value: unknown): string => {
  if (typeof value !== "string") {
    panic("Expected an error stack");
  }
  return value
    .split("\n")
    .map((line, index) => {
      if (index === 0 || line === "    at unknown") {
        return line;
      }
      expect(line).toMatch(STACK_FRAME);
      return line.replace(/:\d+:\d+(\)?)$/u, ":[line]:[column]$1");
    })
    .join("\n");
};

/** Compare all source-bearing fields with a clean, trusted construction. */
export const assertSettingsErrorLocations = (
  actual: Error,
  expected: Error,
): void => {
  expect(normalizeStack(reflectedValue(actual, "stack"))).toBe(
    normalizeStack(reflectedValue(expected, "stack")),
  );
  expect(reflectedValue(actual, "sourceURL")).toBe(
    reflectedValue(expected, "sourceURL"),
  );
  for (const key of ["line", "column", "originalLine", "originalColumn"]) {
    const actualValue = reflectedValue(actual, key);
    const expectedValue = reflectedValue(expected, key);
    expect(typeof actualValue).toBe(typeof expectedValue);
  }
};

export const assertSettingsAnalyticsFrame = (value: unknown): unknown => {
  const normalizedFrame = normalizeFrame(value);
  expect(normalizedFrame).toBe(
    `${REPOSITORY_ROOT}apps/api/src/lib/ai-config-response.ts:[line]:[column]`,
  );
  return normalizedFrame;
};

const ownRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    panic("Expected an object record");
  }
  return Object.fromEntries(Object.entries(value));
};

const arrayValue = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) {
    panic("Expected an array");
  }
  return value;
};

const normalizedDevProjection = (error: Error): unknown => {
  const projection = serializeDevError(error);
  expect(projection).toBeObject();
  const record = ownRecord(projection);
  expect(record["sourceURL"]).toMatch(REPOSITORY_SOURCE);
  const stackValue = record["stack"];
  if (typeof stackValue !== "string") {
    panic("Expected a serialized error stack");
  }
  const stack = stackValue.split("\n");
  for (const frame of stack.slice(1)) {
    expect(frame === "    at unknown" || STACK_FRAME.test(frame)).toBe(true);
  }
  return {
    ...record,
    stack: normalizeStack(stackValue),
  };
};

const assertReturnedAllowlist = (returned: unknown): void => {
  const graph = descriptorGraph(returned);
  expect(JSON.stringify(graph)).not.toContain("cause");
  expect(JSON.stringify(graph)).not.toContain("metadata");

  if (returned instanceof Error) {
    assertSourceLocations(returned);
    if ("code" in returned) {
      expect(Reflect.ownKeys(returned).toSorted(compareKeys)).toEqual(
        [
          "_tag",
          "claim",
          "clause",
          "code",
          "column",
          "confirmation",
          "contactUrl",
          "error",
          "hint",
          "issues",
          "line",
          "message",
          "name",
          "originalColumn",
          "originalLine",
          "requiredFields",
          "retryAfterMs",
          "retryable",
          "sourceURL",
          "stack",
          "status",
          "stepUp",
          "usage",
        ].toSorted(compareKeys),
      );
      // Every serialized field (error, hint, issues, ...) must equal the
      // canonical error's, so stored data cannot ride on an allowlisted key.
      expect(errorPayload(returned)).toStrictEqual(
        errorPayload(storedAIConfigUnreadableError()),
      );
      return;
    }
    expect(Reflect.ownKeys(returned).toSorted(compareKeys)).toEqual(
      [
        "_tag",
        "column",
        "line",
        "message",
        "name",
        "originalColumn",
        "originalLine",
        "reason",
        "sourceURL",
        "stack",
      ].toSorted(compareKeys),
    );
    expect(errorPayload(returned)).toStrictEqual({
      _tag: "OrgAIConfigReadError",
      message: "Decrypted organization AI configuration is unreadable",
      name: "OrgAIConfigReadError",
      reason: Reflect.get(returned, "reason"),
    });
    return;
  }
  if (
    typeof returned === "object" &&
    returned !== null &&
    "orgAIConfigStatus" in returned
  ) {
    expect(graph).toEqual(
      descriptorGraph({
        orgAIConfig: null,
        orgAIConfigStatus: "unreadable",
        promptCachingEnabled: null,
        managedAIResidency: null,
      }),
    );
    return;
  }
  expect(graph).toEqual(
    descriptorGraph({
      code: 503,
      response: {
        code: "ai_config_stored_unreadable",
        message: "Stored AI configuration could not be read",
      },
    }),
  );
};

/** Assert a classified decryption failure before a reader replaces it. */
export const assertClassifiedSettingsFailure = (
  error: unknown,
  reason: OrgAIConfigReadFailure,
): void => {
  if (!(error instanceof Error)) {
    panic("Expected a classified settings Error");
  }
  assertSourceLocations(error);
  expect(errorPayload(error)).toStrictEqual({
    _tag: "OrgAIConfigReadError",
    message: "Decrypted organization AI configuration is unreadable",
    name: "OrgAIConfigReadError",
    reason,
  });
};

/** Assert the complete observable output of one unreadable-settings path. */
export const assertSettingsFailureConfidential = ({
  reason,
  organizationId,
  outputs,
}: {
  reason: OrgAIConfigReadFailure;
  organizationId: SafeId<"organization">;
  outputs: SettingsFailureOutputs;
}): void => {
  const diagnostic = {
    severityText: "WARN",
    message: "organization_ai_config.read_failed",
    attributes: {
      action: "decrypt",
      organizationId,
      reason,
      source: "organization_ai_config",
    },
  };
  const isDirectFailure =
    outputs.returned instanceof Error ||
    (typeof outputs.returned === "object" &&
      outputs.returned !== null &&
      "orgAIConfigStatus" in outputs.returned);
  if (isDirectFailure) {
    expect(outputs.logRecords).toEqual([diagnostic]);
    expect(outputs.developmentEntries).toEqual([]);
    expect(outputs.analyticsEvents).toEqual([]);
  } else {
    expect(outputs.logRecords.at(0)).toEqual(diagnostic);
    expect(outputs.logRecords).toHaveLength(2);
    const requestRecord = outputs.logRecords.at(1);
    const requestAttributes = ownRecord(requestRecord?.attributes);
    expect(requestAttributes["request.duration_ms"]).toBeNumber();
    const requestFrame = normalizeFrame(requestAttributes["error.frame"]);
    const normalizedRequestRecord: Record<string, unknown> = {
      ...ownRecord(requestRecord),
      attributes: {
        ...requestAttributes,
        "error.frame": requestFrame,
        "request.duration_ms": "[duration]",
      },
    };
    expect(normalizedRequestRecord).toEqual({
      severityText: "ERROR",
      message: "request.failed",
      attributes: {
        "http.method": "GET",
        "http.route": "/tests/handler-context",
        "http.status_code": 503,
        "request.duration_ms": "[duration]",
        "error.type": "HandlerError",
        "error.status_code": 503,
        "error.class": "HandlerError",
        "error.code": "ai_config_stored_unreadable",
        "error.frame": `${REPOSITORY_ROOT}apps/api/src/lib/ai-config-response.ts:[line]:[column]`,
        "failure.grade": "defect",
        "failure.reason": "tagged_failure",
        "failure.shadow": "true",
      },
    });
    expect(outputs.developmentEntries).toHaveLength(1);
    expect(outputs.developmentLogInputs).toHaveLength(1);
    const event = outputs.analyticsEvents.at(0);
    expect(outputs.analyticsEvents).toHaveLength(1);
    if (event?.event !== "$exception") {
      panic("Expected an exception analytics event");
    }
    const properties = ownRecord(event.properties);
    const normalizedFrame = assertSettingsAnalyticsFrame(
      properties["error.frame"],
    );
    expect(properties["$exception_fingerprint"]).toBe(
      '[["HandlerError"],"api.safeHandlerFailure",["[\\"request\\",\\"GET\\",\\"/tests/handler-context\\"]"],"ai_config_stored_unreadable","",{}]',
    );
    const exceptionList = arrayValue(properties["$exception_list"]);
    expect(exceptionList).toHaveLength(1);
    const exceptionEntry = ownRecord(exceptionList.at(0));
    const exceptionValue = exceptionEntry["value"];
    expect(exceptionValue).toBeString();
    expect(exceptionValue).toMatch(
      /^HandlerError\[ai_config_stored_unreadable\] 503 tagged_failure defect at apps\/api\/src\/lib\/ai-config-response\.ts:\d+:\d+$/u,
    );
    const normalizedEvent: Record<string, unknown> = {
      ...ownRecord(event),
      properties: {
        ...properties,
        $exception_list: [
          { ...exceptionEntry, value: "[classified-exception]" },
        ],
        "error.frame": normalizedFrame,
      },
    };
    expect(normalizedEvent).toEqual({
      distinctId: "server",
      event: "$exception",
      properties: {
        method: "GET",
        route: "/tests/handler-context",
        $exception_fingerprint:
          '[["HandlerError"],"api.safeHandlerFailure",["[\\"request\\",\\"GET\\",\\"/tests/handler-context\\"]"],"ai_config_stored_unreadable","",{}]',
        $exception_level: "error",
        $exception_list: [
          {
            mechanism: { handled: true, synthetic: false, type: "generic" },
            type: "HandlerError",
            value: "[classified-exception]",
          },
        ],
        $exception_type: "HandlerError",
        "error.class": "HandlerError",
        "error.code": "ai_config_stored_unreadable",
        "error.frame": `${REPOSITORY_ROOT}apps/api/src/lib/ai-config-response.ts:[line]:[column]`,
        "failure.grade": "defect",
        "failure.reason": "tagged_failure",
        "failure.shadow": "true",
      },
    });

    expect(outputs.captureEntries).toHaveLength(1);
    const captureCall = arrayValue(outputs.captureEntries.at(0));
    const capturedError = captureCall.at(0);
    if (!(capturedError instanceof Error)) {
      panic("Expected captureObservedError to receive an Error");
    }
    assertSourceLocations(capturedError);
    expect(errorPayload(capturedError)).toStrictEqual(
      errorPayload(storedAIConfigUnreadableError()),
    );
    const captureOptions = ownRecord(captureCall.at(1));
    const captureRequest = captureOptions["request"];
    if (!(captureRequest instanceof Request)) {
      panic("Expected captureObservedError to receive a Request");
    }
    expect(captureRequest.method).toBe("GET");
    expect(captureRequest.url).toBe("https://example.test/handler-context");
    const normalizedCaptureOptions: Record<string, unknown> = {
      ...captureOptions,
      request: "[request]",
    };
    expect(normalizedCaptureOptions).toEqual({
      fingerprintKey: "api.safeHandlerFailure",
      scope: {
        type: "request",
        method: "GET",
        routeTemplate: "/tests/handler-context",
      },
      request: "[request]",
      context: { method: "GET", route: "/tests/handler-context" },
      observation: {
        grade: "defect",
        reason: "tagged_failure",
        evidenceDepth: 0,
        rule: "tag",
      },
    });

    const consoleCall = arrayValue(outputs.developmentEntries.at(0));
    expect(consoleCall).toHaveLength(1);
    const developmentError = consoleCall.at(0);
    if (!(developmentError instanceof Error)) {
      panic("Expected the development logger to receive an Error");
    }
    assertSourceLocations(developmentError);
    const canonicalDevelopmentError = sanitizeDiagnosticErrorForOutput(
      storedAIConfigUnreadableError(),
    );
    if (!(canonicalDevelopmentError instanceof Error)) {
      panic("Expected the canonical development error to be an Error");
    }
    expect(errorPayload(developmentError)).toStrictEqual(
      errorPayload(canonicalDevelopmentError),
    );
    const developmentProjection = ownRecord(
      normalizedDevProjection(developmentError),
    );
    const canonicalProjection = ownRecord(
      normalizedDevProjection(canonicalDevelopmentError),
    );
    const trustedStack =
      outputs.trustedDevelopmentStack ??
      panic("Expected a trusted development stack");
    expect(developmentProjection).toStrictEqual({
      ...canonicalProjection,
      stack: trustedStack,
    });
    const devLogCall = arrayValue(outputs.developmentLogInputs?.at(0));
    expect(devLogCall).toHaveLength(2);
    const devLogError = devLogCall.at(0);
    if (!(devLogError instanceof Error)) {
      panic("Expected logServerDevError to receive an Error");
    }
    assertSourceLocations(devLogError);
    expect(errorPayload(devLogError)).toStrictEqual(
      errorPayload(canonicalDevelopmentError),
    );
    expect(normalizeStack(reflectedValue(devLogError, "stack"))).toBe(
      trustedStack,
    );
    expect(devLogCall.at(1)).toEqual(properties);
    expect(outputs.developmentJsonlEntries).toHaveLength(1);
    const { when, ...jsonlRecord } = ownRecord(
      outputs.developmentJsonlEntries?.at(0),
    );
    expect(when).toBeString();
    expect(jsonlRecord).toStrictEqual({
      tag: "Error",
      context: properties,
      error: serializeDevError(developmentError),
    });
  }
  if (isDirectFailure) {
    expect(outputs.captureEntries).toEqual([]);
  }
  expect(outputs.groupIdentifies).toEqual([]);
  assertReturnedAllowlist(outputs.returned);
};
