/**
 * An in-memory organization for the playbook-authoring eval: the smallest
 * `McpRequestContext` the production `list_playbooks` and `save_playbook`
 * handlers run over. The eval calls `handleMcpToolCall`, so the schema parse,
 * the lenient value readers, the merge, the shared create and update paths,
 * and the error envelope are all production code; only the rows live here.
 */

import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type {
  PlaybookPositions,
  PlaybookScope,
} from "@/api/lib/workflow/playbook-positions";
import type { McpRequestContext } from "@/api/mcp/context";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

export type StoredPlaybook = {
  id: string;
  name: string;
  description: string | null;
  scope: PlaybookScope | null;
  positions: PlaybookPositions;
  status: "draft" | "approved";
  approvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PlaybookStore = {
  context: McpRequestContext;
  playbooks: () => readonly StoredPlaybook[];
  /**
   * Move a playbook's `updatedAt` forward, as a person saving in the editor
   * would: the next save carrying the older token is a conflict.
   */
  touch: (playbookId: string) => void;
};

const STORE_EPOCH = new Date("2026-09-01T00:00:00.000Z");
const MATTER_ID = "00000000-0000-4000-8000-0000000000e1";

const playbookIdOf = (where: unknown): string | undefined => {
  if (typeof where !== "object" || where === null || !("id" in where)) {
    return undefined;
  }
  const { id } = where;
  if (typeof id !== "object" || id === null || !("eq" in id)) {
    return undefined;
  }
  return typeof id.eq === "string" ? id.eq : undefined;
};

export const createPlaybookStore = (
  seed: readonly StoredPlaybook[],
): PlaybookStore => {
  const rows = new Map(seed.map((row) => [row.id, structuredClone(row)]));
  // Strictly increasing, so two writes in one millisecond still differ.
  let clock = Math.max(
    STORE_EPOCH.getTime(),
    ...seed.map((row) => row.updatedAt.getTime()),
  );
  const tick = () => {
    clock += 1000;
    return new Date(clock);
  };
  // The update path names its row in a drizzle condition this fake cannot
  // read. Every write is preceded by the handler's own detail read, whose
  // relational `where` it can, so the write addresses the row last read.
  let lastReadId: string | undefined;
  const lastRead = () =>
    lastReadId === undefined ? undefined : rows.get(lastReadId);

  const tx = {
    $count: () => rows.size,
    query: {
      playbookDefinitions: {
        findFirst: ({ where }: { where: unknown }) => {
          lastReadId = playbookIdOf(where);
          return lastRead();
        },
      },
      // Every eval scenario leaves `scope.document_type_key` unset.
      documentTypes: { findFirst: () => undefined },
    },
    select: () => ({
      from: () => ({
        where: () => ({
          for: () => {
            const row = lastRead();
            return row === undefined ? [] : [{ updatedAt: row.updatedAt }];
          },
          orderBy: () => ({
            limit: () => [...rows.values()],
          }),
        }),
      }),
    }),
    insert: () => ({
      values: (values: {
        id: string;
        name: string;
        description: string | null;
        scope: PlaybookScope | null;
        positions: PlaybookPositions;
      }) => ({
        returning: () => {
          const now = tick();
          rows.set(values.id, {
            ...values,
            status: "draft",
            approvedAt: null,
            createdAt: now,
            updatedAt: now,
          });
          return [{ id: values.id }];
        },
      }),
    }),
    update: () => ({
      set: (values: Partial<StoredPlaybook>) => ({
        where: () => ({
          returning: () => {
            const row = lastRead();
            if (row === undefined) {
              return [];
            }
            const updatedAt = tick();
            rows.set(row.id, { ...row, ...values, updatedAt });
            return [{ updatedAt }];
          },
        }),
      }),
    }),
  };

  const scopedDb = asTestRaw<McpRequestContext["scopedDb"]>(
    async (run: (transaction: unknown) => unknown) => await run(tx),
  );

  return {
    context: {
      accessibleWorkspaceIds: [toSafeId<"workspace">(MATTER_ID)],
      accessibleWorkspaceIdSet: new Set([MATTER_ID]),
      accessibleWorkspaceStatusById: new Map([[MATTER_ID, "active"]]),
      accessibleWorkspaces: [],
      grantedScopes: [],
      memberRole: "owner",
      organizationId: mintAuthProviderId<"organization">(),
      recordAuditEvent: asTestRaw<AuditRecorder>(() => undefined),
      testDependencies: {
        // Saving a graded position derives its ask with a model call. The eval
        // measures the tool contract, not that derivation, and `unreadable` is
        // the production state in which a save makes no call.
        loadOrgSettingsForAuth: async () =>
          await Promise.resolve({
            orgAIConfig: null,
            orgAIConfigStatus: ORG_AI_CONFIG_STATUS.unreadable,
            promptCachingEnabled: false,
          }),
      },
      safeDb: toSafeDbMock(scopedDb),
      scopedDb,
      userId: toSafeId<"user">("user_eval"),
    },
    playbooks: () => [...rows.values()],
    touch: (playbookId) => {
      const row = rows.get(playbookId);
      if (row !== undefined) {
        rows.set(playbookId, { ...row, updatedAt: tick() });
      }
    },
  };
};
