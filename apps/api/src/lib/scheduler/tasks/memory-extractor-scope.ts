import { panic } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";

export const EXTRACTABLE_MEMORY_KINDS = [
  "fact",
  "decision",
  "relationship",
  "preference",
  "instruction",
] as const;

export type ExtractableMemoryKind = (typeof EXTRACTABLE_MEMORY_KINDS)[number];

const MEMORY_KIND_SCOPE = {
  fact: "workspace",
  decision: "workspace",
  relationship: "workspace",
  preference: "user",
  instruction: "user",
} as const satisfies Record<ExtractableMemoryKind, "user" | "workspace">;

type ResolveExtractedMemoryScopeOptions = {
  kind: ExtractableMemoryKind;
  threadDataWorkspaceIds: SafeId<"workspace">[];
  threadUserId: SafeId<"user">;
  threadWorkspaceId: SafeId<"workspace"> | null;
};

type ExtractedMemoryScope =
  | { type: "drop" }
  | {
      type: "user";
      sourceDataWorkspaceIds: [];
      userId: SafeId<"user">;
      workspaceId: null;
    }
  | {
      type: "workspace";
      sourceDataWorkspaceIds: SafeId<"workspace">[];
      userId: null;
      workspaceId: SafeId<"workspace">;
    };

export const resolveExtractedMemoryScope = ({
  kind,
  threadDataWorkspaceIds,
  threadUserId,
  threadWorkspaceId,
}: ResolveExtractedMemoryScopeOptions): ExtractedMemoryScope => {
  let sourceDataWorkspaceIds = threadDataWorkspaceIds;
  if (sourceDataWorkspaceIds.length === 0 && threadWorkspaceId) {
    sourceDataWorkspaceIds = [threadWorkspaceId];
  }

  const scope = MEMORY_KIND_SCOPE[kind];
  switch (scope) {
    case "workspace":
      if (
        !threadWorkspaceId ||
        sourceDataWorkspaceIds.length !== 1 ||
        sourceDataWorkspaceIds.at(0) !== threadWorkspaceId
      ) {
        return { type: "drop" };
      }
      return {
        type: "workspace",
        workspaceId: threadWorkspaceId,
        userId: null,
        sourceDataWorkspaceIds,
      };
    case "user":
      if (sourceDataWorkspaceIds.length > 0) {
        // Preferences and instructions inferred from a matter-derived summary
        // are not safely portable: the model may have mislabeled client facts.
        return { type: "drop" };
      }
      return {
        type: "user",
        userId: threadUserId,
        workspaceId: null,
        sourceDataWorkspaceIds: [],
      };
    default:
      scope satisfies never;
      return panic(`Unhandled scope: ${String(scope)}`);
  }
};
