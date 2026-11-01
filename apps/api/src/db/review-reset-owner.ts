import { Result, TaggedError } from "better-result";
import { eq } from "drizzle-orm";

import type { SafeId } from "../lib/branded-types";
import { withAggregateRowQuery } from "../lib/db/aggregate-lock";
import { organization } from "./auth-schema";
import { proveOrgScope, withOrgScope } from "./org-scope";
import type { OrgScope } from "./org-scope";
import type { Transaction } from "./root";
import { reviewResetOrganizations } from "./schema/review-reset-organizations";

const REVIEW_RESET_ACTOR: unique symbol = Symbol("stella.reviewResetActor");
export type ReviewResetActor = {
  type: "review-reset";
  userId: SafeId<"user"> | null;
  readonly [REVIEW_RESET_ACTOR]: true;
};

export class ReviewResetNotRegistered extends TaggedError(
  "ReviewResetNotRegistered",
)<{
  message: string;
}> {}

type AdmitReviewResetOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user"> | null;
};

type RegisteredReviewResetOptions = Omit<
  AdmitReviewResetOptions,
  "organizationId"
> & { scope: OrgScope };

/** Holds the live registry row and organization for this reset transaction. */
export class RegisteredReviewReset {
  private readonly tx: Transaction;
  private readonly scope: OrgScope;
  private readonly userId: SafeId<"user"> | null;

  private constructor({ tx, scope, userId }: RegisteredReviewResetOptions) {
    this.tx = tx;
    this.scope = scope;
    this.userId = userId;
  }

  static async admit({
    tx,
    organizationId,
    userId,
  }: AdmitReviewResetOptions): Promise<RegisteredReviewReset> {
    const scope = await proveOrgScope(tx, {
      table: "organization",
      where: eq(organization.id, organizationId),
    });
    const registration = await withAggregateRowQuery({
      tx,
      aggregate: "reviewResetRegistration",
      id: organizationId,
      mode: "key share",
      select: (connection) =>
        connection
          .select({ organizationId: reviewResetOrganizations.organizationId })
          .from(reviewResetOrganizations)
          .limit(1),
    });
    const row = registration.rows.at(0);
    if (Result.isError(scope) || row === undefined) {
      throw new ReviewResetNotRegistered({
        message: "The organization is not registered for reset",
      });
    }
    return new RegisteredReviewReset({ tx, scope: scope.value, userId });
  }

  async run<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return await withOrgScope({
      tx: this.tx,
      scope: this.scope,
      actor: {
        type: "review-reset",
        userId: this.userId,
        [REVIEW_RESET_ACTOR]: true,
      },
      fn,
    });
  }
}
