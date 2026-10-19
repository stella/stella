import { defineProof, name } from "@gdp-ts/core";
import type { Named, Proof } from "@gdp-ts/core";
import { Result } from "better-result";
import { sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import { canWriteWorkspaceEntities } from "@/api/lib/entities/workspace-entity-write-access";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isRecord } from "@/api/lib/type-guards";

export type MatterReadable<U, M, T, O> = Proof<"MatterReadable", [U, M, T, O]>;
export type MatterWritable<U, M, T, O> = Proof<"MatterWritable", [U, M, T, O]>;

const MatterReadableProver = defineProof("MatterReadable");
const MatterWritableProver = defineProof("MatterWritable");

type MatterAccessOptions<Need extends "read" | "write"> = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
  need: Need;
  lock?: () => Promise<void>;
};

type MatterAccessContext<
  Kind extends "MatterReadable" | "MatterWritable",
  U,
  M,
  T,
  O,
> = {
  tx: Named<T, Transaction>;
  matter: Named<M, SafeId<"workspace">>;
  actor: Named<U, SafeId<"user">>;
  proof: Proof<Kind, [U, M, T, O]>;
};

type AccessRow = {
  allowed: boolean;
  organizationRole: string | null;
};

const isAccessRow = (value: unknown): value is AccessRow =>
  isRecord(value) &&
  typeof value["allowed"] === "boolean" &&
  (typeof value["organizationRole"] === "string" ||
    value["organizationRole"] === null);

const refusal = () =>
  Result.err(
    new HandlerError({ status: 403, message: "Matter access required" }),
  );

export function withMatterAccess<R, E>(
  options: MatterAccessOptions<"read">,
  run: <U, M, T, O>(
    context: MatterAccessContext<"MatterReadable", U, M, T, O>,
  ) => Promise<Result<R, E>>,
): Promise<Result<R, E | HandlerError>>;
export function withMatterAccess<R, E>(
  options: MatterAccessOptions<"write">,
  run: <U, M, T, O>(
    context: MatterAccessContext<"MatterWritable", U, M, T, O>,
  ) => Promise<Result<R, E>>,
): Promise<Result<R, E | HandlerError>>;
export async function withMatterAccess<R, E>(
  {
    tx,
    organizationId,
    userId,
    workspaceId,
    need,
    lock,
  }: MatterAccessOptions<"read" | "write">,
  run: (...context: never[]) => Promise<Result<R, E>>,
): Promise<Result<R, E | HandlerError>> {
  return await name(
    userId,
    workspaceId,
    tx,
    async (actor, matter, transaction) =>
      await name(organizationId, async (organization) => {
        if (lock) {
          await lock();
        }
        const rows = await tx.execute(sql<AccessRow>`
          SELECT
            stella_workspace_access(
              ${organization.value}, ${actor.value}, ${matter.value}::uuid
            ) AS allowed,
            (
              SELECT m.role
              FROM member m
              WHERE m.organization_id = ${organization.value}
                AND m.user_id = ${actor.value}
              LIMIT 1
            ) AS "organizationRole"
        `);
        const access = rows.at(0);
        if (!isAccessRow(access) || !access.allowed) {
          return refusal();
        }
        if (
          need === "write" &&
          !canWriteWorkspaceEntities({
            organizationRole: access.organizationRole,
            reachesMatter: access.allowed,
          })
        ) {
          return refusal();
        }
        const proof =
          need === "write"
            ? MatterWritableProver.prove(
                actor,
                matter,
                transaction,
                organization,
              )
            : MatterReadableProver.prove(
                actor,
                matter,
                transaction,
                organization,
              );
        return await Reflect.apply(run, undefined, [
          { tx: transaction, matter, actor, proof },
        ]);
      }),
  );
}
