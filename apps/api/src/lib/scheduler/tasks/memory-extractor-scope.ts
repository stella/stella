import type { SafeId } from "@/api/lib/branded-types";

export type ExtractableMemoryKind =
  | "fact"
  | "decision"
  | "relationship"
  | "preference"
  | "instruction";

const MATTER_KINDS: ReadonlySet<ExtractableMemoryKind> = new Set([
  "fact",
  "decision",
  "relationship",
]);

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

  if (MATTER_KINDS.has(kind)) {
    if (!threadWorkspaceId) {
      return { type: "drop" };
    }
    return {
      type: "workspace",
      workspaceId: threadWorkspaceId,
      userId: null,
      sourceDataWorkspaceIds,
    };
  }

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
};
