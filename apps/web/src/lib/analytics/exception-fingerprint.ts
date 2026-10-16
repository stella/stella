import { isTaggedError, Result } from "better-result";

import {
  exceptionCauseChainIdentity,
  exceptionCauseFieldsIdentity,
  MAX_EXCEPTION_CAUSE_DEPTH,
} from "@stll/errors/exception-cause-chain";
import type { ExceptionScope } from "@stll/errors/exception-scope";
import { exceptionScopeIdentity } from "@stll/errors/exception-scope";
import { readFingerprintFields } from "@stll/errors/fingerprint-fields";

import { telemetryErrorType } from "@/lib/analytics/error-diagnostics";
import { API_ERROR_TAG } from "@/lib/errors/api-tag";

// Capture owners declare these keys in source. Engine-inferred symbols can
// contain computed user data and minified names, so they are never identity.
export type ExceptionFingerprintKey = `${string}:${string}`;

export const isExceptionFingerprintKey = (
  value: unknown,
): value is ExceptionFingerprintKey =>
  typeof value === "string" &&
  /^[A-Za-z][A-Za-z0-9_.-]{0,159}:[A-Za-z0-9_.%~-]{1,511}$/u.test(value);

type FingerprintEntry = {
  type: string;
};

/** Validated API response classifications; response text never enters identity. */
export type ApiErrorIdentity = {
  status: number;
  code?: string | undefined;
};

const API_ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const HTTP_STATUS_MIN = 100;
const HTTP_STATUS_MAX = 599;

type ReadApiErrorIdentityOptions = { status: unknown; code: unknown };

/** Only validated HTTP classifications participate in telemetry identity. */
export const readApiErrorIdentity = ({
  status,
  code,
}: ReadApiErrorIdentityOptions): ApiErrorIdentity | undefined => {
  if (
    typeof status !== "number" ||
    !Number.isInteger(status) ||
    status < HTTP_STATUS_MIN ||
    status > HTTP_STATUS_MAX
  ) {
    return undefined;
  }
  return {
    status,
    ...(typeof code === "string" && API_ERROR_CODE.test(code) ? { code } : {}),
  };
};

/** Wrappers preserve their API outcome; arbitrary response text is excluded. */
export const capturedApiErrorIdentity = (
  error: unknown,
): ApiErrorIdentity | undefined =>
  Result.try(() => {
    const seen = new Set<object>();
    let current = error;
    while (
      typeof current === "object" &&
      current !== null &&
      !seen.has(current) &&
      seen.size < MAX_EXCEPTION_CAUSE_DEPTH
    ) {
      seen.add(current);
      if (isTaggedError(current) && current._tag === API_ERROR_TAG) {
        return readApiErrorIdentity({
          status: Reflect.get(current, "status"),
          code: Reflect.get(current, "code"),
        });
      }
      current = Reflect.get(current, "cause");
    }
    return undefined;
  }).unwrapOr(undefined);

type ExceptionFingerprintInput = {
  entries: readonly FingerprintEntry[];
  key: ExceptionFingerprintKey;
  scopeIdentity: ExceptionScopeFingerprint;
  http?: ApiErrorIdentity | undefined;
  fields?: Readonly<Record<string, string>> | undefined;
};

// Every causal class participates; source positions and messages do not.
export const fingerprintExceptionEvent = ({
  entries,
  key,
  scopeIdentity,
  http,
  fields,
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
    Object.entries(fields ?? {}).toSorted(([left], [right]) => {
      if (left === right) {
        return 0;
      }
      return left < right ? -1 : 1;
    }),
  ]);

/** Read classifications before stack redaction removes error objects and causes. */
const MAX_PROTOTYPE_DEPTH = 16;

export const capturedExceptionIdentity = (error: unknown) =>
  Result.try(() => {
    let current = error;
    const seen = new Set<Error>();
    const nodes: Parameters<typeof exceptionCauseFieldsIdentity>[0][number][] =
      [];
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
    const types: string[] = [];
    while (
      current instanceof Error &&
      !seen.has(current) &&
      seen.size < MAX_EXCEPTION_CAUSE_DEPTH
    ) {
      seen.add(current);
      const type = telemetryErrorType(current);
      types.push(type);
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
      nodes.push({ type, fields: declared });
      current = current.cause;
    }
    return {
      types: types.length > 0 ? types : [telemetryErrorType(error)],
      fields: exceptionCauseFieldsIdentity(nodes),
    };
  }).unwrapOr({ types: ["UnknownError"], fields: {} });

export const sanitizeFingerprintFields = (
  value: unknown,
): Record<string, string> =>
  Result.try(() => {
    const fields = new Map<string, string>();
    if (typeof value !== "object" || value === null) {
      return Object.fromEntries(fields);
    }
    for (const [key, field] of Object.entries(value)) {
      if (
        /^[A-Za-z][A-Za-z0-9_.-]{0,159}\.(?:reason|phase|stage|termination)(?:\.(?:reason|phase|stage|termination))*$/u.test(
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
