/**
 * A member's learned dictation fixes as the server keeps them: one
 * encrypted row per member and organization. Devices send the changes they
 * made (`@stll/transcript/learned-fixes`); the server applies them with the
 * same code the devices use offline and answers with the result, which every
 * device then adopts. A write replaces the row only at the revision it read,
 * so concurrent syncs apply their changes in turn.
 */
import { panic } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import {
  DICTATION_LEARNED_FIX_LIMITS,
  DICTATION_LEARNED_FIX_STATUSES,
  DICTATION_LEARNED_FIX_SWITCHES,
  type DictationLearnedFixChanges,
  type DictationLearnedFixes,
  dictationLearnedFixSchema,
} from "@stll/api-contract/dictation-learned-fixes";
import {
  applyLearnedFixChanges,
  LEARNED_FIX_LIMIT,
  LEARNED_FIX_STATUSES,
  LEARNED_FIX_SWITCHES,
} from "@stll/transcript/learned-fixes";

import type { Transaction } from "@/api/db/root";
import { dictationLearnedFixes } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { decryptContent, encryptContent } from "@/api/lib/content-encryption";

// The wire contract and the rules that apply its changes name the same
// statuses, switches and limit.
DICTATION_LEARNED_FIX_STATUSES satisfies typeof LEARNED_FIX_STATUSES;
LEARNED_FIX_STATUSES satisfies typeof DICTATION_LEARNED_FIX_STATUSES;
DICTATION_LEARNED_FIX_SWITCHES satisfies typeof LEARNED_FIX_SWITCHES;
LEARNED_FIX_SWITCHES satisfies typeof DICTATION_LEARNED_FIX_SWITCHES;
DICTATION_LEARNED_FIX_LIMITS.fixes satisfies typeof LEARNED_FIX_LIMIT;
LEARNED_FIX_LIMIT satisfies typeof DICTATION_LEARNED_FIX_LIMITS.fixes;

export type LearnedFixOwner = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

/** Change ids remembered, so a retried change is applied once. */
const REMEMBERED_CHANGE_IDS = 500;
/** Concurrent writes a change waits out before it gives up. */
const WRITE_ATTEMPTS = 5;

/** What the encrypted column holds. */
const storedSchema = v.strictObject({
  fixes: v.array(dictationLearnedFixSchema),
  changeIds: v.array(v.string()),
});

type Stored = v.InferOutput<typeof storedSchema>;

type Row = { generation: number; revision: number; stored: Stored };

const EMPTY: Stored = { fixes: [], changeIds: [] };

/** The member's row: the primary key, so at most one. */
const ownedBy = (owner: LearnedFixOwner) =>
  and(
    eq(dictationLearnedFixes.organizationId, owner.organizationId),
    eq(dictationLearnedFixes.userId, owner.userId),
  );

/** The encrypted column, read back. */
const decrypted = async (
  organizationId: SafeId<"organization">,
  { ciphertext, iv }: { ciphertext: Buffer; iv: Buffer },
): Promise<Stored> => {
  const plaintext = await decryptContent(organizationId, ciphertext, iv);
  const parsed = v.safeParse(storedSchema, JSON.parse(plaintext));
  if (!parsed.success) {
    // Only this module writes the column; a row it cannot read is a bug.
    return panic("Stored learned dictation fixes do not match their schema");
  }
  return parsed.output;
};

const readRow = async (
  tx: Transaction,
  owner: LearnedFixOwner,
): Promise<Row | null> => {
  const [row] = await tx
    .select({
      generation: dictationLearnedFixes.generation,
      revision: dictationLearnedFixes.revision,
      ciphertext: dictationLearnedFixes.ciphertext,
      iv: dictationLearnedFixes.iv,
    })
    .from(dictationLearnedFixes)
    .where(ownedBy(owner));
  if (row === undefined) {
    return null;
  }
  return {
    generation: row.generation,
    revision: row.revision,
    stored: await decrypted(owner.organizationId, row),
  };
};

/**
 * Writes `next` over the row read at `read` (none: a new row). False when
 * another write got there first, and the caller reads again.
 */
const writeRow = async (
  tx: Transaction,
  owner: LearnedFixOwner,
  {
    read,
    generation,
    next,
  }: { read: Row | null; generation: number; next: Stored },
): Promise<boolean> => {
  const { ciphertext, iv } = await encryptContent(
    owner.organizationId,
    JSON.stringify(next),
  );
  if (read === null) {
    // audit: skip - the member's own dictation spellings, synced between their devices
    const inserted = await tx
      .insert(dictationLearnedFixes)
      .values({ ...owner, generation, revision: 0, ciphertext, iv })
      .onConflictDoNothing()
      .returning({ revision: dictationLearnedFixes.revision });
    return inserted.length > 0;
  }
  // audit: skip - the member's own dictation spellings, synced between their devices
  const updated = await tx
    .update(dictationLearnedFixes)
    .set({
      generation,
      revision: read.revision + 1,
      ciphertext,
      iv,
      updatedAt: new Date(),
    })
    .where(
      and(ownedBy(owner), eq(dictationLearnedFixes.revision, read.revision)),
    )
    .returning({ revision: dictationLearnedFixes.revision });
  return updated.length > 0;
};

const snapshot = (
  generation: number,
  { fixes }: Stored,
): DictationLearnedFixes => ({ generation, fixes });

/** Reads, changes and writes the row until no other write came between. */
const rewrite = async (
  tx: Transaction,
  owner: LearnedFixOwner,
  change: (read: Row | null) => { generation: number; next: Stored } | null,
): Promise<DictationLearnedFixes> => {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    // db-await-in-loop: a bounded retry that rereads only after a lost race
    const read = await readRow(tx, owner);
    const changed = change(read);
    if (changed === null) {
      return snapshot(read?.generation ?? 0, read?.stored ?? EMPTY);
    }
    // db-await-in-loop: a bounded retry; one write per attempt, in order
    if (await writeRow(tx, owner, { read, ...changed })) {
      return snapshot(changed.generation, changed.next);
    }
  }
  return panic("Learned dictation fixes kept changing under one write");
};

/** The member's fixes; none yet is generation 0 with no fixes. */
export const readLearnedFixes = async (
  tx: Transaction,
  owner: LearnedFixOwner,
): Promise<DictationLearnedFixes> => {
  const row = await readRow(tx, owner);
  return snapshot(row?.generation ?? 0, row?.stored ?? EMPTY);
};

/**
 * Applies a device's changes, in order, and answers with the result. Changes
 * made in an older generation (before the member deleted everything stella
 * learned) and changes already applied are skipped.
 */
export const changeLearnedFixes = async (
  tx: Transaction,
  owner: LearnedFixOwner,
  { generation, changes }: DictationLearnedFixChanges,
): Promise<DictationLearnedFixes> =>
  await rewrite(tx, owner, (read) => {
    const current = read?.stored ?? EMPTY;
    if (generation !== (read?.generation ?? 0)) {
      return null;
    }
    const applied = new Set(current.changeIds);
    // A change repeated within one request is applied once, too.
    const fresh = changes.filter(({ id }) => {
      if (applied.has(id)) {
        return false;
      }
      applied.add(id);
      return true;
    });
    if (fresh.length === 0) {
      return null;
    }
    return {
      generation,
      next: {
        fixes: applyLearnedFixChanges(current.fixes, fresh),
        changeIds: [...current.changeIds, ...fresh.map(({ id }) => id)].slice(
          -REMEMBERED_CHANGE_IDS,
        ),
      },
    };
  });

/** Deletes everything stella learned for the member, on every device. */
export const clearLearnedFixes = async (
  tx: Transaction,
  owner: LearnedFixOwner,
): Promise<DictationLearnedFixes> =>
  await rewrite(tx, owner, (read) => ({
    generation: (read?.generation ?? 0) + 1,
    next: EMPTY,
  }));

/** A member's row as their account export holds it: the fixes, readable. */
export const toLearnedFixesAccountExport = async (
  organizationId: SafeId<"organization">,
  row: typeof dictationLearnedFixes.$inferSelect,
): Promise<DictationLearnedFixes & { updatedAt: string }> => ({
  ...snapshot(row.generation, await decrypted(organizationId, row)),
  updatedAt: row.updatedAt.toISOString(),
});
