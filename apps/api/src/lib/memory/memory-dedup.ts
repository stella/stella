import type { SafeId } from "@/api/lib/branded-types";

type MemoryDedupScope =
  | {
      scope: "organization";
      userId: null;
      workspaceId: null;
    }
  | {
      scope: "user";
      userId: SafeId<"user">;
      workspaceId: null;
    }
  | {
      scope: "workspace";
      userId: null;
      workspaceId: SafeId<"workspace">;
    };

type CreateMemoryDedupIdentityOptions = MemoryDedupScope & {
  content: string;
  kind: "preference" | "instruction" | "fact" | "decision" | "relationship";
  sourceDataWorkspaceIds: readonly SafeId<"workspace">[];
};

type MemoryDedupIdentity = {
  dedupKey: string;
  sourceDataWorkspaceIds: SafeId<"workspace">[];
};

export const createMemoryDedupIdentity = ({
  content,
  kind,
  scope,
  sourceDataWorkspaceIds,
  userId,
  workspaceId,
}: CreateMemoryDedupIdentityOptions): MemoryDedupIdentity => {
  const canonicalSourceWorkspaceIds = Array.from(
    new Set(sourceDataWorkspaceIds),
  ).sort();
  const canonicalIdentity = JSON.stringify({
    version: 1,
    scope,
    userId,
    workspaceId,
    kind,
    content,
    sourceDataWorkspaceIds: canonicalSourceWorkspaceIds,
  });

  return {
    dedupKey: new Bun.CryptoHasher("sha256")
      .update(canonicalIdentity)
      .digest("hex"),
    sourceDataWorkspaceIds: canonicalSourceWorkspaceIds,
  };
};
