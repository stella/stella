/**
 * API surface of the bilingual translation flow: prepare a document for
 * review, start a run over the reviewed decisions, and follow that run while
 * the worker executes it.
 *
 * Every vocabulary the UI renders is derived from the endpoints' own types, so
 * a value the server adds cannot land in the client as an unhandled string.
 */

import { queryOptions } from "@tanstack/react-query";
import { panic } from "better-result";

import type { TranslationKey } from "@/i18n/types";
import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";

/** Poll cadence while a run is still queued or executing. */
const RUN_POLL_INTERVAL_MS = 2000;

/** Mirrors `BILINGUAL_LIMITS` on the API: the schema rejects anything above. */
export const BILINGUAL_GLOSSARY_MAX = 300;
export const BILINGUAL_TERM_MAX = 120;
export const BILINGUAL_FORMS_MAX = 12;

type PrepareBilingualTranslationArgs = {
  workspaceId: string;
  entityId: string;
  fieldId: string;
  sourceLang: string;
  targetLang: string;
};

export const prepareBilingualTranslation = async ({
  workspaceId,
  entityId,
  fieldId,
  sourceLang,
  targetLang,
}: PrepareBilingualTranslationArgs) =>
  unwrapEden(
    await api
      .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
      ["bilingual-translations"].prepare.post({
        entityId: toSafeId<"entity">(entityId),
        fieldId: toSafeId<"field">(fieldId),
        sourceLang,
        targetLang,
      }),
  );

export type BilingualPreparation = Awaited<
  ReturnType<typeof prepareBilingualTranslation>
>;
export type BilingualPreparedRow = BilingualPreparation["rows"][number];
export type BilingualGlossaryEntry = BilingualPreparation["glossary"][number];
export type BilingualRowDisposition = BilingualPreparedRow["disposition"];
export type BilingualGlossaryOrigin = BilingualGlossaryEntry["origin"];

type CreateBilingualRunArgs = {
  workspaceId: string;
  entityId: string;
  fieldId: string;
  entityVersionId: string;
  sourceLang: string;
  targetLang: string;
  glossary: BilingualGlossaryEntry[];
  rows: { rowId: string; disposition: BilingualRowDisposition }[];
};

export const createBilingualRun = async ({
  workspaceId,
  entityId,
  fieldId,
  entityVersionId,
  sourceLang,
  targetLang,
  glossary,
  rows,
}: CreateBilingualRunArgs) =>
  unwrapEden(
    await api
      .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
      ["bilingual-translations"].runs.post({
        entityId: toSafeId<"entity">(entityId),
        fieldId: toSafeId<"field">(fieldId),
        entityVersionId: toSafeId<"entityVersion">(entityVersionId),
        sourceLang,
        targetLang,
        glossary,
        rows,
      }),
  );

type BilingualRunRef = {
  workspaceId: string;
  runId: string;
};

export const bilingualRunKeys = {
  all: (workspaceId: string) =>
    ["bilingual-translation-runs", workspaceId] as const,
  detail: (ref: BilingualRunRef) =>
    [...bilingualRunKeys.all(ref.workspaceId), "detail", ref.runId] as const,
};

const fetchBilingualRun = async (
  { workspaceId, runId }: BilingualRunRef,
  signal?: AbortSignal,
) =>
  unwrapEden(
    await api
      .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
      ["bilingual-translations"].runs({
        runId: toSafeId<"bilingualTranslationRun">(runId),
      })
      .get({ ...(signal === undefined ? {} : { fetch: { signal } }) }),
  );

export type BilingualRunDetail = Awaited<ReturnType<typeof fetchBilingualRun>>;
export type BilingualRunRow = BilingualRunDetail["rows"][number];
type BilingualRunStatus = BilingualRunDetail["run"]["status"];
type BilingualRunErrorCode = NonNullable<
  BilingualRunDetail["run"]["errorCode"]
>;

export const bilingualRunOptions = (ref: BilingualRunRef) =>
  queryOptions({
    queryKey: bilingualRunKeys.detail(ref),
    queryFn: async ({ signal }) => await fetchBilingualRun(ref, signal),
    // Rows land while the worker executes; a stale answer would show progress
    // that has already moved on.
    staleTime: 0,
    refetchInterval: (query) => {
      const status = query.state.data?.run.status;
      return status === undefined ? false : runPollInterval(status);
    },
  });

const runPollInterval = (status: BilingualRunStatus): number | false => {
  switch (status) {
    case "queued":
    case "running":
      return RUN_POLL_INTERVAL_MS;
    case "completed":
    case "failed":
    case "cancelled":
      return false;
    default:
      status satisfies never;
      return panic(`Unhandled status: ${String(status)}`);
  }
};

/** Which of the run panel's three surfaces a status calls for. */
export type BilingualRunView = "progress" | "done" | "stopped";

export const bilingualRunView = (
  status: BilingualRunStatus,
): BilingualRunView => {
  switch (status) {
    case "queued":
    case "running":
      return "progress";
    case "completed":
      return "done";
    case "failed":
    case "cancelled":
      return "stopped";
    default:
      status satisfies never;
      return panic(`Unhandled status: ${String(status)}`);
  }
};

/**
 * The disposition vocabulary, in the order the picker offers it. The map is
 * the enumeration: a disposition the API adds fails the `satisfies` here
 * rather than reaching the picker as a value it cannot label.
 */
export const BILINGUAL_DISPOSITION_LABEL_KEYS = {
  translate: "common.translate",
  keep: "bilingualTranslate.dispositions.keep",
  inline: "bilingualTranslate.dispositions.inline",
} as const satisfies Record<BilingualRowDisposition, TranslationKey>;

export const isBilingualRowDisposition = (
  value: unknown,
): value is BilingualRowDisposition =>
  typeof value === "string" && value in BILINGUAL_DISPOSITION_LABEL_KEYS;

export const BILINGUAL_ROW_KIND_LABEL_KEYS = {
  paragraph: "bilingualTranslate.kinds.paragraph",
  heading: "bilingualTranslate.kinds.heading",
  listItem: "bilingualTranslate.kinds.listItem",
  table: "bilingualTranslate.kinds.table",
} as const satisfies Record<BilingualPreparedRow["kind"], TranslationKey>;

export const BILINGUAL_GLOSSARY_ORIGIN_LABEL_KEYS = {
  detected: "bilingualTranslate.glossary.origins.detected",
  // A proposed rendering came from the same model pass as a model-decided
  // disposition, so it wears the same badge.
  proposed: "bilingualTranslate.origins.model",
  user: "bilingualTranslate.glossary.origins.user",
} as const satisfies Record<BilingualGlossaryOrigin, TranslationKey>;

/**
 * The badge a row's disposition origin earns, or `null` for the origins the
 * reviewer needs no warning about: a rule-stamped disposition is a
 * deterministic fact, and one the reviewer chose is their own.
 */
export const annotatedOriginLabelKey = (
  origin: BilingualPreparedRow["dispositionOrigin"],
) => {
  switch (origin) {
    case "model":
      return "bilingualTranslate.origins.model";
    case "default":
      return "bilingualTranslate.origins.default";
    case "rule":
    case "user":
      return null;
    default:
      origin satisfies never;
      return panic(`Unhandled origin: ${String(origin)}`);
  }
};

const BILINGUAL_ERROR_CODE_KEYS = {
  document_unresolved: "bilingualTranslate.errorCodes.documentUnresolved",
  document_changed: "bilingualTranslate.errorCodes.documentChanged",
  not_bilingual: "bilingualTranslate.errorCodes.notBilingual",
  ai_unavailable: "bilingualTranslate.errorCodes.aiUnavailable",
  translation_failed: "bilingualTranslate.errorCodes.translationFailed",
  apply_failed: "bilingualTranslate.errorCodes.applyFailed",
  enqueue_failed: "bilingualTranslate.errorCodes.enqueueFailed",
  internal: "bilingualTranslate.errorCodes.internal",
} as const satisfies Record<BilingualRunErrorCode, TranslationKey>;

export const bilingualErrorCodeKey = (
  errorCode: BilingualRunErrorCode | null,
) =>
  errorCode === null
    ? "bilingualTranslate.errorCodes.unknown"
    : BILINGUAL_ERROR_CODE_KEYS[errorCode];
