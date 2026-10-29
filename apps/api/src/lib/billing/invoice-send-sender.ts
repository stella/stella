import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";

import { member, organization, user as authUser } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import {
  emailColumnMatches,
  normalizeEmail,
} from "@/api/lib/email/normalized-email";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

type InvoiceEmailSenderOptions = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  sellerProfileId: SafeId<"sellerProfile"> | null;
};

/** Who the email names and who receives the replies. */
export const readInvoiceEmailSender = async (
  tx: Transaction,
  options: InvoiceEmailSenderOptions,
) => {
  const seller =
    options.sellerProfileId === null
      ? undefined
      : await tx.query.sellerProfiles.findFirst({
          where: {
            id: { eq: options.sellerProfileId },
            organizationId: { eq: options.organizationId },
          },
          columns: { legalName: true, email: true },
        });
  const [firm] = await tx
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, options.organizationId));
  const [sender] = await tx
    .select({ email: authUser.email })
    .from(member)
    .innerJoin(authUser, eq(authUser.id, member.userId))
    .where(
      and(
        eq(member.organizationId, options.organizationId),
        eq(authUser.id, options.userId),
        eq(authUser.emailVerified, true),
        isNull(authUser.deletedAt),
      ),
    )
    .limit(1);
  if (sender === undefined) {
    return Result.err(
      new HandlerError({
        status: 403,
        message: "Verify your email address before sending an invoice.",
      }),
    );
  }
  const sellerEmail = seller?.email;
  const verifiedSeller =
    sellerEmail === null || sellerEmail === undefined
      ? undefined
      : (
          await tx
            .select({ email: authUser.email })
            .from(member)
            .innerJoin(authUser, eq(authUser.id, member.userId))
            .where(
              and(
                eq(member.organizationId, options.organizationId),
                emailColumnMatches(authUser.email, normalizeEmail(sellerEmail)),
                eq(authUser.emailVerified, true),
                isNull(authUser.deletedAt),
              ),
            )
            .limit(1)
        ).at(0);
  return Result.ok({
    firmName: seller?.legalName ?? firm?.name ?? "",
    replyTo: verifiedSeller?.email ?? sender.email,
  });
};
