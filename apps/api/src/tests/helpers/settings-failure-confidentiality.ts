import { expect } from "bun:test";

import type { OrgAIConfigReadFailure } from "@/api/lib/ai-config-crypto";
import type {
  OrganizationGroupIdentifyParams,
  ServerAnalyticsCaptureParams,
} from "@/api/lib/analytics/server-analytics";
import type { SafeId } from "@/api/lib/branded-types";
import type { LogRecord } from "@/api/lib/observability/logger";

type SettingsFailureOutputs = {
  analyticsEvents: readonly ServerAnalyticsCaptureParams[];
  captureEntries: readonly unknown[];
  developmentEntries: readonly unknown[];
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

const assertReturnedAllowlist = (returned: unknown): void => {
  const graph = descriptorGraph(returned);
  expect(JSON.stringify(graph)).not.toContain("cause");
  expect(JSON.stringify(graph)).not.toContain("metadata");

  if (returned instanceof Error) {
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
      expect(returned).toMatchObject({
        code: "ai_config_stored_unreadable",
        message: "Stored AI configuration could not be read",
        status: 503,
      });
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
    expect(requestRecord?.severityText).toBe("ERROR");
    expect(requestRecord?.message).toBe("request.failed");
    expect(
      Object.keys(requestRecord?.attributes ?? {}).toSorted(compareKeys),
    ).toEqual(
      [
        "error.class",
        "error.code",
        "error.frame",
        "error.status_code",
        "error.type",
        "failure.grade",
        "failure.reason",
        "failure.shadow",
        "http.method",
        "http.route",
        "http.status_code",
        "request.duration_ms",
      ].toSorted(compareKeys),
    );
    expect(outputs.developmentEntries).toHaveLength(1);
    const event = outputs.analyticsEvents.at(0);
    expect(outputs.analyticsEvents).toHaveLength(1);
    expect(event?.event).toBe("$exception");
    expect(Object.keys(event ?? {}).toSorted(compareKeys)).toEqual(
      ["distinctId", "event", "properties"].toSorted(compareKeys),
    );
    expect(Object.keys(event?.properties ?? {}).toSorted(compareKeys)).toEqual(
      [
        "$exception_fingerprint",
        "$exception_level",
        "$exception_list",
        "$exception_type",
        "error.class",
        "error.code",
        "error.frame",
        "failure.grade",
        "failure.reason",
        "failure.shadow",
        "method",
        "route",
      ].toSorted(compareKeys),
    );
  }
  expect(outputs.captureEntries).toEqual([]);
  expect(outputs.groupIdentifies).toEqual([]);
  assertReturnedAllowlist(outputs.returned);
};
