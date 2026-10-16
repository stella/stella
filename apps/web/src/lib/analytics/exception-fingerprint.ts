import { Result } from "better-result";

import {
  exceptionCauseChainIdentity,
  exceptionDiscriminatorIdentity,
  MAX_EXCEPTION_CAUSE_DEPTH,
} from "@stll/errors/exception-cause-chain";
import type { ExceptionIdentityNode } from "@stll/errors/exception-cause-chain";
import type { ExceptionScope } from "@stll/errors/exception-scope";
import { exceptionScopeIdentity } from "@stll/errors/exception-scope";
import { readFingerprintFields } from "@stll/errors/fingerprint-fields";

import {
  telemetryErrorType,
  normalizeTelemetryErrorTypeName,
} from "@/lib/analytics/error-diagnostics";

// Capture owners declare these keys in source. Engine-inferred symbols can
// contain computed user data and minified names, so they are never identity.
export type ExceptionFingerprintKey = `${string}:${string}`;

export const isExceptionFingerprintKey = (
  value: unknown,
): value is ExceptionFingerprintKey =>
  typeof value === "string" &&
  /^[A-Za-z][A-Za-z0-9_.-]{0,159}:[A-Za-z0-9_.%~-]{1,511}$/u.test(value);

/** Validated API response classifications; response text never enters identity. */
export type ApiErrorIdentity = {
  status: number;
  code?: string | undefined;
};

type ExceptionFingerprintInput = {
  entries: readonly ExceptionIdentityNode[];
  key: ExceptionFingerprintKey;
  scopeIdentity: ExceptionScopeFingerprint;
  http?: ApiErrorIdentity | undefined;
};

// Every causal class participates; source positions and messages do not.
export const fingerprintExceptionEvent = ({
  entries,
  key,
  scopeIdentity,
  http,
}: ExceptionFingerprintInput): string =>
  JSON.stringify([
    exceptionCauseChainIdentity({
      root: 0,
      readNode: (index) => ({
        type: entries.at(index)?.type ?? "UnknownError",
        cause: index + 1 < entries.length ? index + 1 : undefined,
      }),
    }),
    key,
    scopeIdentity,
    http?.status ?? null,
    http?.code ?? null,
    exceptionDiscriminatorIdentity(entries),
  ]);

/** Read classifications before stack redaction removes error objects and causes. */
const MAX_PROTOTYPE_DEPTH = 16;

export const capturedExceptionIdentity = (error: unknown) =>
  Result.try(() => {
    let current = error;
    const seen = new Set<Error>();
    const reads = new WeakMap<object, Map<string, unknown>>();
    const read = (value: object, key: string): unknown => {
      let cached = reads.get(value);
      if (cached === undefined) {
        cached = new Map();
        reads.set(value, cached);
      }
      if (cached.has(key)) {
        return cached.get(key);
      }
      const result: unknown = Reflect.get(value, key);
      cached.set(key, result);
      return result;
    };
    const entries: ExceptionIdentityNode[] = [];
    while (
      current instanceof Error &&
      !seen.has(current) &&
      seen.size < MAX_EXCEPTION_CAUSE_DEPTH
    ) {
      seen.add(current);
      const type = telemetryErrorType(current);
      const prototypes: object[] = [];
      let prototype: unknown = Object.getPrototypeOf(current);
      while (
        typeof prototype === "object" &&
        prototype !== null &&
        prototypes.length < MAX_PROTOTYPE_DEPTH
      ) {
        prototypes.push(prototype);
        prototype = Object.getPrototypeOf(prototype);
      }
      const declared = readFingerprintFields({
        value: current,
        prototypes,
        read,
      });
      entries.push({ type, discriminators: declared ?? {} });
      current = current.cause;
    }
    return {
      entries:
        entries.length > 0
          ? entries
          : [{ type: telemetryErrorType(error), discriminators: {} }],
    };
  }).unwrapOr({ entries: [{ type: "UnknownError", discriminators: {} }] });

const sanitizeDiscriminators = (value: unknown): Record<string, string> =>
  Result.try(() => {
    const fields = new Map<string, string>();
    if (typeof value !== "object" || value === null) {
      return Object.fromEntries(fields);
    }
    for (const [key, field] of Object.entries(value)) {
      if (
        /^(?:reason|phase|stage|termination)(?:\.(?:reason|phase|stage|termination))*$/u.test(
          key,
        ) &&
        typeof field === "string" &&
        /^[A-Za-z0-9_-]{1,80}$/u.test(field)
      ) {
        fields.set(key, field);
      }
    }
    return Object.fromEntries(fields);
  }).unwrapOr({});

/** Only source-declared per-node classifications cross the SDK boundary. */
export const sanitizeExceptionIdentityEntries = (
  value: unknown,
): ExceptionIdentityNode[] | undefined =>
  Result.try(() => {
    if (!Array.isArray(value) || value.length === 0) {
      return undefined;
    }
    return value.slice(0, MAX_EXCEPTION_CAUSE_DEPTH).map((entry: unknown) =>
      Result.try(() => {
        if (typeof entry !== "object" || entry === null) {
          return { type: "UnknownError", discriminators: {} };
        }
        const type: unknown = Reflect.get(entry, "type");
        return {
          type: normalizeTelemetryErrorTypeName(
            typeof type === "string" ? type : "",
          ),
          discriminators: sanitizeDiscriminators(
            Reflect.get(entry, "discriminators"),
          ),
        };
      }).unwrapOr({ type: "UnknownError", discriminators: {} }),
    );
  }).unwrapOr(undefined);

/** Route templates come from the router, before dynamic parameters resolve. */
export const routeExceptionFingerprintKey = (
  routeTemplate: string,
): ExceptionFingerprintKey => `routeError:${encodeURIComponent(routeTemplate)}`;

const AUTOMATIC_MESSAGE_LIMIT = 8192;
const HASH_OFFSET = 14_695_981_039_346_656_037n;
const HASH_PRIME = 1_099_511_628_211n;
const HASH_BITS = 64;

/** A bounded opaque identity; readable messages remain excluded from events. */
const automaticMessageHash = (message: string): string => {
  const normalized = message
    .slice(0, AUTOMATIC_MESSAGE_LIMIT)
    .replace(
      /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|“[^”]*”|‘[^’]*’|«[^»]*»/gu,
      "<value>",
    )
    .replace(/https?:\/\/\S+|[^\s@]+@[^\s@]+\.[^\s@]+/gu, "<value>")
    .replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/giu, "<id>")
    .replace(/\b[0-9a-f]{16,}\b|\b[0-9A-HJKMNP-TV-Z]{26}\b/giu, "<id>")
    .replace(/\b[A-Za-z_-]*\d[A-Za-z0-9_-]*\b/gu, "<id>")
    .replace(/\d+(?:\.\d+)?/gu, "<number>")
    .replace(/\s+/gu, " ")
    .trim();
  let hash = HASH_OFFSET;
  for (const character of normalized) {
    hash = BigInt.asUintN(
      HASH_BITS,
      hash * HASH_PRIME + BigInt(character.codePointAt(0) ?? 0),
    );
  }
  return hash.toString(16);
};

type AutomaticExceptionKeyOptions = {
  entries: readonly {
    stacktrace?: { frames: readonly { filename?: string; in_app?: boolean }[] };
  }[];
  message: string;
  firstPartyOrigin: string;
};

/** SDK captures have no declared caller: use an owned asset and message shape. */
export const automaticExceptionKey = ({
  entries,
  message,
  firstPartyOrigin,
}: AutomaticExceptionKeyOptions): ExceptionFingerprintKey => {
  const appOrigin = new URL(firstPartyOrigin).origin;
  for (const entry of entries.toReversed()) {
    const frames = entry.stacktrace?.frames ?? [];
    for (const frame of frames.toReversed()) {
      if (
        frame.in_app === false ||
        frame.filename === undefined ||
        !URL.canParse(frame.filename, firstPartyOrigin)
      ) {
        continue;
      }
      const url = new URL(frame.filename, firstPartyOrigin);
      if (url.origin !== appOrigin || !url.pathname.startsWith("/assets/")) {
        continue;
      }
      const basename = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
      if (!/^[A-Za-z0-9_.-]{1,160}\.m?js$/u.test(basename)) {
        continue;
      }
      // Vite emits an eight-character content hash, separate from the asset owner.
      const owner = basename.replace(/-[A-Za-z0-9_-]{8}(?=\.m?js$)/u, "");
      return `browser:${owner}.${automaticMessageHash(message)}`;
    }
  }
  return `browser:frameless.${automaticMessageHash(message)}`;
};

export type ExceptionScopeFingerprint = `scope:${string}`;

/** Source-declared scope is hashed before entering SDK properties. */
export const fingerprintExceptionScope = (
  scope: ExceptionScope,
): ExceptionScopeFingerprint => {
  let hash = HASH_OFFSET;
  for (const character of exceptionScopeIdentity(scope)) {
    hash = BigInt.asUintN(
      HASH_BITS,
      hash * HASH_PRIME + BigInt(character.codePointAt(0) ?? 0),
    );
  }
  return `scope:${hash.toString(16)}`;
};

export const isExceptionScopeFingerprint = (
  value: unknown,
): value is ExceptionScopeFingerprint =>
  typeof value === "string" && /^scope:[0-9a-f]{1,16}$/u.test(value);
