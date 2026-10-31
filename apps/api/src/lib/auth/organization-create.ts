import { APIError } from "better-auth/api";
import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";

import {
  createOrganizationSlug,
  ORGANIZATION_SLUG_RANDOM_BYTES,
} from "@stll/api-contract/organization-create";
import { classifyFailure } from "@stll/errors";

import type { RootDatabase } from "@/api/db/root";
import { organizationCreationRequests as receipts } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { recordOrganizationCreationAudit } from "@/api/lib/db/audit-recording";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { fingerprintRequest } from "@/api/lib/idempotency/request-receipts";
import { isPgConstraintError } from "@/api/lib/pg-error";
import { brandPersistedOrganizationId } from "@/api/lib/safe-id-boundaries";

const MAX_SLUG_ATTEMPTS = 20;

const slugConflict = () =>
  new HandlerError({
    status: 409,
    code: "organization_slug_conflict",
    message: "Organization slug is already in use.",
    hint: "Call organizations.create with a different slug, or omit slug to generate one.",
  });

const isSlugConflict = (error: unknown) =>
  (error instanceof APIError &&
    (error.body?.code === "ORGANIZATION_ALREADY_EXISTS" ||
      error.body?.code === "ORGANIZATION_SLUG_ALREADY_TAKEN")) ||
  isPgConstraintError(error, "23505", "organization_slug_key") ||
  isPgConstraintError(error, "23505", "organization_slug_uidx");

export type CreateOrganizationOptions = {
  userId: SafeId<"user">;
  name: string;
  slug?: string;
  idempotencyKey: string | null;
};

export type OrganizationCreationDependencies = {
  randomBytes?: () => Uint8Array;
  database: Pick<
    RootDatabase,
    "insert" | "select" | "delete" | "update" | "transaction"
  >;
  createOrganization: (input: {
    body: {
      name: string;
      slug: string;
      userId: SafeId<"user">;
      keepCurrentActiveOrganization: true;
    };
  }) => Promise<{ id: string; name: string; slug: string }>;
};

type OrganizationProviderDependencies = Required<
  Pick<OrganizationCreationDependencies, "createOrganization" | "randomBytes">
>;

const createWithAvailableSlug = async (
  {
    userId,
    name,
    slug,
  }: Pick<CreateOrganizationOptions, "userId" | "name" | "slug">,
  { createOrganization, randomBytes }: OrganizationProviderDependencies,
) => {
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    const candidate = slug ?? createOrganizationSlug(randomBytes());
    // no-network-await-in-loop: bounded collision retries must observe the preceding unique-slug refusal before drawing the next random slug.
    const created = await Result.tryPromise({
      try: async () =>
        await createOrganization({
          body: {
            name,
            slug: candidate,
            userId,
            keepCurrentActiveOrganization: true,
          },
        }),
      catch: (cause) => cause,
    });
    if (Result.isError(created)) {
      if (isSlugConflict(created.error)) {
        if (slug === undefined) {
          continue;
        }
        return Result.err(slugConflict());
      }
      if (
        created.error instanceof APIError &&
        created.error.statusCode === 403
      ) {
        return Result.err(
          new HandlerError({
            status: 403,
            code: "account_access_unavailable",
            message: "Organization creation is unavailable for this account.",
            hint: "Sign in with an unrestricted account.",
          }),
        );
      }
      // An unknown failure may follow a committed better-auth write. Keep the
      // claim pending rather than risking a duplicate organization on retry.
      return Result.err(
        classifyFailure(
          new HandlerError({
            status: 500,
            code: "internal_error",
            message: "Organization creation could not be completed.",
            cause: created.error,
          }),
          "tagged_failure",
        ),
      );
    }
    return created;
  }
  return Result.err(slugConflict());
};

/** Root access is limited to this authenticated account's creation receipts; better-auth owns organization writes. */
export const createOrganizationForAccount = async (
  { userId, name, slug, idempotencyKey }: CreateOrganizationOptions,
  {
    database,
    createOrganization,
    randomBytes = () =>
      crypto.getRandomValues(new Uint8Array(ORGANIZATION_SLUG_RANDOM_BYTES)),
  }: OrganizationCreationDependencies,
) => {
  const fingerprint = fingerprintRequest({
    method: "POST",
    route: "organizations.create",
    body: { name, slug },
    params: {},
    query: {},
  });
  const key = idempotencyKey;
  if (key !== null) {
    if (key.length === 0 || key.length > 128) {
      return Result.err(
        new HandlerError({
          status: 400,
          code: "invalid_idempotency_key",
          message: "Idempotency-Key must contain 1 to 128 characters.",
        }),
      );
    }
    // audit: skip - Coordination receipt; the resource creation is audited below.
    const claimed = await database
      .insert(receipts)
      .values({ userId, key, fingerprint })
      .onConflictDoNothing()
      .returning({ key: receipts.key });
    if (claimed.length === 0) {
      const receipt = (
        await database
          .select()
          .from(receipts)
          .where(and(eq(receipts.userId, userId), eq(receipts.key, key)))
          .limit(1)
      ).at(0);
      if (receipt === undefined) {
        panic("Conflicting organization receipt disappeared");
      }
      if (receipt.fingerprint !== fingerprint) {
        return Result.err(
          new HandlerError({
            status: 409,
            code: "idempotency_key_reused",
            message: "This key identifies a different creation request.",
            hint: "Retry the original input, or use a new Idempotency-Key for a new organization.",
          }),
        );
      }
      if (
        receipt.organizationId !== null &&
        receipt.name !== null &&
        receipt.slug !== null
      ) {
        return Result.ok({
          organizationId: receipt.organizationId,
          name: receipt.name,
          slug: receipt.slug,
          role: "owner" as const,
        });
      }
      return Result.err(
        new HandlerError({
          status: 409,
          code: "idempotency_in_progress",
          message: "Organization creation is still pending.",
          hint: "Retry with the same Idempotency-Key later. If it remains pending, contact support; do not create a second organization.",
        }),
      );
    }
  }
  const reject = async (error: HandlerError) => {
    if (key !== null) {
      // audit: skip - A known refusal created no organization, so the coordination claim can be released.
      await database
        .delete(receipts)
        .where(and(eq(receipts.userId, userId), eq(receipts.key, key)));
    }
    return Result.err(error);
  };
  const created = await createWithAvailableSlug(
    { userId, name, ...(slug === undefined ? {} : { slug }) },
    { createOrganization, randomBytes },
  );
  if (created.isErr()) {
    // Unknown failures may follow a committed write; retain the claim.
    return created.error.status >= 500 ? created : await reject(created.error);
  }
  const result = {
    organizationId: brandPersistedOrganizationId(created.value.id),
    name: created.value.name,
    slug: created.value.slug,
    role: "owner" as const,
  };
  await withAggregateTransaction(database, async (tx) => {
    await recordOrganizationCreationAudit(tx, {
      userId,
      organizationId: result.organizationId,
    });
    if (key !== null) {
      // audit: skip - Receipt completion accompanies the account audit event in the same transaction.
      await tx
        .update(receipts)
        .set({
          organizationId: result.organizationId,
          name: result.name,
          slug: result.slug,
        })
        .where(and(eq(receipts.userId, userId), eq(receipts.key, key)));
    }
  });
  return Result.ok(result);
};
