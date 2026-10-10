import { panic, Result, TaggedError } from "better-result";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";
import type {
  DesktopBillingDraft,
  DesktopBillingDraftClassification,
  DesktopBillingDraftOperation,
  DesktopBillingDraftRequest,
  DesktopBillingDraftResponse,
} from "@stll/api-contract/desktop-billing-drafts";

const OPERATION_EFFECT = {
  rewrite: "scalar",
  change_classification: "scalar",
  set_billable: "scalar",
  split: "structural",
  merge: "structural",
  move: "structural",
} as const satisfies Record<
  DesktopBillingDraftOperation["type"],
  "scalar" | "structural"
>;

export class BillingDraftValidationError extends TaggedError(
  "BillingDraftValidationError",
)<{ message: string }> {}

export type BillingDraftValidationContext = {
  entries: (DesktopBillingDraftRequest["entries"][number] & {
    entryId: string;
  })[];
  matters: readonly { matterId: string; ledesEnabled: boolean }[];
  earlierEntries: readonly { id: string; matterId: string }[];
  guidelines: readonly {
    fileId: string;
    fileName: string;
    sections: readonly string[];
    matterIds?: readonly string[];
  }[];
};

const refuse = (message: string) =>
  Result.err(new BillingDraftValidationError({ message }));

type ValidateBillingDraftOperationsOptions = {
  draft: DesktopBillingDraft;
  entry: BillingDraftValidationContext["entries"][number];
  entries: ReadonlyMap<
    string,
    BillingDraftValidationContext["entries"][number]
  >;
  matters: ReadonlyMap<
    string,
    BillingDraftValidationContext["matters"][number]
  >;
  consumed: Map<string, string>;
  operationOwners: ReadonlySet<string>;
  validClassification: (
    classification: DesktopBillingDraftClassification,
    matterId: string,
  ) => boolean;
};

const validateOperations = ({
  draft,
  entry,
  entries,
  matters,
  consumed,
  operationOwners,
  validClassification,
}: ValidateBillingDraftOperationsOptions) => {
  if (
    draft.operations.length > 1 &&
    draft.operations.some(({ type }) => OPERATION_EFFECT[type] === "structural")
  ) {
    return refuse(
      "A structural operation cannot be combined with other operations on its owner",
    );
  }
  const operationTypes = new Set<string>();
  for (const operation of draft.operations) {
    if (operationTypes.has(operation.type)) {
      return refuse("Duplicate operation types are ambiguous");
    }
    operationTypes.add(operation.type);
    switch (operation.type) {
      case "rewrite":
      case "set_billable":
        break;
      case "change_classification":
        if (!validClassification(operation.classification, entry.matterId)) {
          return refuse(
            "Operation classification does not match the matter billing format",
          );
        }
        break;
      case "split": {
        let total = 0;
        for (const part of operation.parts) {
          total += part.durationMinutes;
          if (!validClassification(part.classification, entry.matterId)) {
            return refuse(
              "Split classification does not match the matter billing format",
            );
          }
        }
        if (total !== entry.durationMinutes) {
          return refuse("Split durations must equal the original duration");
        }
        if (consumed.has(entry.entryId)) {
          return refuse("Structural operations cannot consume an entry twice");
        }
        consumed.set(entry.entryId, entry.entryId);
        break;
      }
      case "merge": {
        const mergeIds = new Set(operation.entryIds);
        if (
          mergeIds.size !== operation.entryIds.length ||
          !mergeIds.has(entry.entryId)
        ) {
          return refuse(
            "Merge must include its owning entry and unique source entries",
          );
        }
        if (!validClassification(operation.classification, entry.matterId)) {
          return refuse(
            "Merge classification does not match the matter billing format",
          );
        }
        for (const id of mergeIds) {
          const source = entries.get(id);
          if (
            !source ||
            source.matterId !== entry.matterId ||
            source.date !== entry.date
          ) {
            return refuse(
              "Merge sources must be selected entries on the same matter and date",
            );
          }
          if (
            consumed.has(id) ||
            (id !== entry.entryId && operationOwners.has(id))
          ) {
            return refuse("Merge sources cannot have conflicting operations");
          }
          consumed.set(id, entry.entryId);
        }
        break;
      }
      case "move":
        if (
          !matters.has(operation.targetMatterId) ||
          operation.targetMatterId === entry.matterId
        ) {
          return refuse(
            "Move target must be a different authorized candidate matter",
          );
        }
        if (
          !validClassification(
            operation.classification,
            operation.targetMatterId,
          )
        ) {
          return refuse(
            "Move classification does not match the target matter billing format",
          );
        }
        if (operation.durationMinutes > entry.durationMinutes) {
          return refuse("Move duration exceeds the original duration");
        }
        if (consumed.has(entry.entryId)) {
          return refuse("Structural operations cannot consume an entry twice");
        }
        consumed.set(entry.entryId, entry.entryId);
        break;
      default:
        return panic("Unknown billing operation", operation satisfies never);
    }
  }
  return Result.ok(undefined);
};

/** Validate suggestions against fresh authorized context, including client-round-tripped results. */
export const validateBillingDraftResult = (
  result: DesktopBillingDraftResponse,
  context: BillingDraftValidationContext,
) => {
  const entries = new Map(
    context.entries.map((entry) => [entry.entryId, entry]),
  );
  const matters = new Map(
    context.matters.map((matter) => [matter.matterId, matter]),
  );
  const earlierEntries = new Map(
    context.earlierEntries.map((entry) => [entry.id, entry]),
  );
  const guidelines = new Map(
    context.guidelines.map((file) => [file.fileId, file]),
  );
  const validClassification = (
    classification: DesktopBillingDraftClassification,
    matterId: string,
  ) => {
    const matter = matters.get(matterId);
    if (!matter) {
      return false;
    }
    switch (classification.type) {
      case "ledes":
        return matter.ledesEnabled;
      case "activity_group":
        // Internal entries require a null matter; every draft in this slice is matter-backed.
        return (
          !matter.ledesEnabled &&
          classification.activityGroup === TIME_ENTRY_ACTIVITY_GROUP.CLIENT
        );
      default:
        return panic(
          "Unknown billing classification",
          classification satisfies never,
        );
    }
  };

  if (entries.size !== context.entries.length) {
    return refuse("Selected entry identifiers must be unique");
  }
  const draftIds = new Set(result.drafts.map((draft) => draft.entryId));
  if (
    draftIds.size !== result.drafts.length ||
    draftIds.size !== entries.size
  ) {
    return refuse("Drafts must cover each selected entry exactly once");
  }
  const checkedIds = new Set(
    result.checkedGuidelines.map((file) => file.fileId),
  );
  if (
    checkedIds.size !== result.checkedGuidelines.length ||
    checkedIds.size !== guidelines.size
  ) {
    return refuse(
      "Checked guidelines must cover the supplied files exactly once",
    );
  }
  for (const checked of result.checkedGuidelines) {
    if (guidelines.get(checked.fileId)?.fileName !== checked.fileName) {
      return refuse("Checked guideline does not match an authorized file");
    }
  }

  // Structural operations consume original entries; overlapping proposals have no safe application order.
  const consumed = new Map<string, string>();
  const operationOwners = new Set(
    result.drafts
      .filter((draft) => draft.operations.length > 0)
      .map((draft) => draft.entryId),
  );

  for (const draft of result.drafts) {
    const entry = entries.get(draft.entryId);
    if (!entry) {
      return refuse("Draft references an unselected entry");
    }
    if (!validClassification(draft.classification, entry.matterId)) {
      return refuse(
        "Draft classification does not match the matter billing format",
      );
    }
    const matchedIds = new Set(draft.matchedEarlierEntryIds);
    if (matchedIds.size !== draft.matchedEarlierEntryIds.length) {
      return refuse("Earlier entry references must be unique");
    }
    for (const id of matchedIds) {
      if (earlierEntries.get(id)?.matterId !== entry.matterId) {
        return refuse(
          "Earlier entry reference is outside the caller's matter context",
        );
      }
    }
    for (const { ruleRef, fix } of draft.flags) {
      const file = guidelines.get(ruleRef.fileId);
      if (
        !file ||
        file.fileName !== ruleRef.fileName ||
        !file.sections.includes(ruleRef.section) ||
        (file.matterIds !== undefined &&
          !file.matterIds.includes(entry.matterId))
      ) {
        return refuse(
          "Guideline flag must cite an authorized file and section for this matter",
        );
      }
      if (
        fix === "split" &&
        !draft.operations.some(({ type }) => type === "split")
      ) {
        return refuse("A split fix must include a reviewable split operation");
      }
    }
    const operations = validateOperations({
      draft,
      entry,
      entries,
      matters,
      consumed,
      operationOwners,
      validClassification,
    });
    if (operations.isErr()) {
      return operations;
    }
  }
  return Result.ok(undefined);
};
