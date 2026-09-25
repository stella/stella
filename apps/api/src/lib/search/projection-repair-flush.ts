import { rootDb } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import {
  createSearchProjectionRepairDeps,
  flushSearchRepairs,
  SEARCH_PROJECTION_KIND,
} from "@/api/lib/search/projection-repair-queue";
import type { SearchProjectionRepairOutcome } from "@/api/lib/search/projection-repair-queue";

/**
 * A mutation's post-commit flush of the search marks it just wrote.
 *
 * The repair queue and the search projections are system state rather than
 * one tenant's rows, and the caller holds a request scope, not a connection
 * that can settle them. These three operations run the flush on the owner
 * connection; each one repairs only the sources it is handed, whose marks the
 * caller's own transaction committed. A flush that never runs loses nothing:
 * the marks stay queued for the standing drain.
 */

export const flushEntitySearchRepairs = async (
  entityIds: readonly SafeId<"entity">[],
): Promise<SearchProjectionRepairOutcome> =>
  await flushSearchRepairs({
    deps: createSearchProjectionRepairDeps(rootDb),
    kind: SEARCH_PROJECTION_KIND.entity,
    sourceIds: entityIds,
  });

export const flushContactSearchRepairs = async (
  contactIds: readonly SafeId<"contact">[],
): Promise<SearchProjectionRepairOutcome> =>
  await flushSearchRepairs({
    deps: createSearchProjectionRepairDeps(rootDb),
    kind: SEARCH_PROJECTION_KIND.contact,
    sourceIds: contactIds,
  });

export const flushWorkspaceSearchRepairs = async (
  workspaceIds: readonly SafeId<"workspace">[],
): Promise<SearchProjectionRepairOutcome> =>
  await flushSearchRepairs({
    deps: createSearchProjectionRepairDeps(rootDb),
    kind: SEARCH_PROJECTION_KIND.workspace,
    sourceIds: workspaceIds,
  });
