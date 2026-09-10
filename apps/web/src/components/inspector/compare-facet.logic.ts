import type { CompareChange, CompareUnsupportedReason } from "@stll/folio-core";

import type { TranslationKey } from "@/i18n/types";
import { DOCX_MIME } from "@/lib/consts";
import type { EntityVersion } from "@/lib/workspaces/queries/entity-versions";

export type CompareChangeKind = CompareChange["kind"];

export const COMPARE_CHANGE_KIND_LABEL_KEYS = {
  insert: "fileDetail.compareChangeKinds.insert",
  delete: "fileDetail.compareChangeKinds.delete",
  replace: "fileDetail.compareChangeKinds.replace",
  move: "fileDetail.compareChangeKinds.move",
  split: "fileDetail.compareChangeKinds.split",
  merge: "fileDetail.compareChangeKinds.merge",
  "paragraph-format": "fileDetail.compareChangeKinds.paragraphFormat",
  format: "folio.textFormattingGroup",
  numbering: "styleSets.editor.numbering",
  "table-insert": "fileDetail.compareChangeKinds.tableInsert",
  "table-delete": "fileDetail.compareChangeKinds.tableDelete",
  "table-row-insert": "fileDetail.compareChangeKinds.tableRowInsert",
  "table-row-delete": "fileDetail.compareChangeKinds.tableRowDelete",
  "table-column-insert": "fileDetail.compareChangeKinds.tableColumnInsert",
  "table-column-delete": "fileDetail.compareChangeKinds.tableColumnDelete",
} as const satisfies Record<CompareChangeKind, TranslationKey>;

export const COMPARE_UNSUPPORTED_REASON_LABEL_KEYS = {
  "story-missing-in-base": "fileDetail.compareUnsupportedReasons.missingInBase",
  "story-missing-in-target":
    "fileDetail.compareUnsupportedReasons.missingInTarget",
  "story-not-editable": "fileDetail.compareUnsupportedReasons.notEditable",
} as const satisfies Record<CompareUnsupportedReason, TranslationKey>;

const isCompareChangeKind = (value: string): value is CompareChangeKind =>
  Object.hasOwn(COMPARE_CHANGE_KIND_LABEL_KEYS, value);

const COMPARE_CHANGE_KINDS = Object.keys(COMPARE_CHANGE_KIND_LABEL_KEYS).filter(
  isCompareChangeKind,
);

export type CompareChangeCount = {
  count: number;
  kind: CompareChangeKind;
};

export const countCompareChanges = (
  changes: readonly Pick<CompareChange, "kind">[],
): CompareChangeCount[] => {
  const counts = new Map<CompareChangeKind, number>();
  for (const { kind } of changes) {
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return COMPARE_CHANGE_KINDS.flatMap((kind) => {
    const count = counts.get(kind);
    return count === undefined ? [] : [{ count, kind }];
  });
};

export type CompareVersionSelection = {
  baseVersionId: string;
  targetVersionId: string;
};

type ResolveCompareVersionSelectionOptions = {
  currentFieldId: string;
  requested: CompareVersionSelection | null;
  versions: readonly EntityVersion[];
};

export const resolveCompareVersionSelection = ({
  currentFieldId,
  requested,
  versions,
}: ResolveCompareVersionSelectionOptions): CompareVersionSelection | null => {
  const comparable = versions
    .filter((version) => version.file?.mimeType === DOCX_MIME)
    .toSorted((left, right) => left.versionNumber - right.versionNumber);
  if (comparable.length < 2) {
    return null;
  }

  const comparableIds = new Set(comparable.map(({ id }) => id));
  if (
    requested !== null &&
    requested.baseVersionId !== requested.targetVersionId &&
    comparableIds.has(requested.baseVersionId) &&
    comparableIds.has(requested.targetVersionId)
  ) {
    return requested;
  }

  const activeIndex = comparable.findIndex(
    ({ file }) => file?.fieldId === currentFieldId,
  );
  const targetIndex = activeIndex !== -1 ? activeIndex : comparable.length - 1;
  if (targetIndex === 0) {
    const base = comparable[0];
    const target = comparable[1];
    if (base === undefined || target === undefined) {
      return null;
    }
    return { baseVersionId: base.id, targetVersionId: target.id };
  }
  const baseIndex = targetIndex > 0 ? targetIndex - 1 : 1;
  const base = comparable[baseIndex];
  const target = comparable[targetIndex];
  if (base === undefined || target === undefined) {
    return null;
  }
  return { baseVersionId: base.id, targetVersionId: target.id };
};
