import { Result } from "better-result";

import type {
  MatterAccessContext,
  MatterReadable,
  MatterWritable,
} from "@/api/lib/workspaces/matter-access-proof";
import { withMatterAccess } from "@/api/lib/workspaces/matter-access-proof";

const checkedRead = <U, M, T, O>(
  context: MatterAccessContext<"read", U, M, T, O>,
) => context.matter.value;
const checkedWrite = <U, M, T, O>(
  context: MatterAccessContext<"write", U, M, T, O>,
) => context.matter.value;

// Compile-only: no function in this file is invoked.
export const matterProofMistakes = <U, M, T, O, Other>(
  context: MatterAccessContext<"read", U, M, T, O>,
  other: MatterAccessContext<"read", Other, Other, Other, Other>,
) => {
  checkedRead(context);
  const { proof, ...withoutProof } = context;
  // @ts-expect-error Reads require evidence.
  checkedRead(withoutProof);
  // @ts-expect-error A readable proof does not authorize writes.
  checkedWrite(context);
  // @ts-expect-error Evidence names the exact transaction.
  checkedRead({ ...context, tx: other.tx });
  // @ts-expect-error Evidence names the exact matter.
  checkedRead({ ...context, matter: other.matter });
  // @ts-expect-error Evidence names the exact actor.
  checkedRead({ ...context, actor: other.actor });
  // @ts-expect-error Raw transaction handles carry no transaction name.
  checkedRead({ ...context, tx: context.tx.value });
  // @ts-expect-error An object literal cannot mint readable evidence.
  // oxlint-disable-next-line gdp-ts/no-matter-proof-forgery -- compile-only negative case proves literal construction fails
  const forgedRead: MatterReadable<U, M, T, O> = {
    kind: "MatterReadable",
    organizationId: proof.organizationId,
  };
  // @ts-expect-error An object literal cannot mint writable evidence.
  // oxlint-disable-next-line gdp-ts/no-matter-proof-forgery -- compile-only negative case proves literal construction fails
  const forgedWrite: MatterWritable<U, M, T, O> = {
    kind: "MatterWritable",
    organizationId: proof.organizationId,
  };
  const changedOrganization: typeof proof = {
    ...proof,
    // @ts-expect-error Evidence names the exact organization.
    organizationId: other.proof.organizationId,
  };
  return { forgedRead, forgedWrite, changedOrganization };
};

// A continuation result, settled as an awaited value.
const done = async <T>(value: T) => await Promise.resolve(Result.ok(value));

export const matterProofCannotEscape = async (
  options: Parameters<typeof withMatterAccess<"read", unknown, never>>[0],
) => {
  // @ts-expect-error The transaction's ghost name cannot escape its continuation.
  await withMatterAccess(options, async ({ proof }) => await done(proof));
  // @ts-expect-error A named transaction cannot escape for use in another scope.
  await withMatterAccess(options, async ({ tx }) => await done(tx));
};

export const matterProofInference = async (
  options: Parameters<typeof withMatterAccess<"write", unknown, never>>[0],
) => {
  const outcome = await withMatterAccess(options, async (context) => {
    checkedWrite(context);
    return await done({ type: "written" } as const);
  });
  if (Result.isError(outcome)) {
    return outcome.error.status;
  }
  return outcome.value.type satisfies "written";
};
