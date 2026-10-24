import { panic, Result } from "better-result";
import { expect } from "bun:test";

import { mintInternalSessionCookieHeader } from "@/api/lib/agent-auth";
import { toSafeId } from "@/api/lib/branded-types";
import { createDesktopLinkGrant } from "@/api/lib/business-registries/desktop/link-grant-store";
import {
  createConfirmationOtp,
  runConfirmedTransaction,
  verifyConfirmationOtp,
} from "@/api/lib/confirmation-otp";
import {
  createDesktopEditHandoffToken,
  createDesktopEditSessionToken,
} from "@/api/lib/desktop-edit-sessions";
import { generateInboundAddressToken } from "@/api/lib/email/inbound/address";
import { createPdfSigningToken } from "@/api/lib/files/pdf-signing/sessions";
import {
  presignUploadUrl,
  resetAwsS3ClientForTesting,
  setScopedS3ClientFactoryForTesting,
  setScopedSigningEnabledForTesting,
} from "@/api/lib/s3-presign";
import { subscribe, subscribeUser } from "@/api/lib/sse";
import { SYNTHETIC_PRINCIPAL } from "@/api/lib/synthetic-principal/constants";
import type {
  CredentialPrincipal,
  USER_SESSION_CREDENTIAL_ISSUERS,
} from "@/api/lib/synthetic-principal/credential-policy";
import { mintAgentRunToken } from "@/api/mcp/agent-run-token";

const syntheticUserId = toSafeId<"user">(SYNTHETIC_PRINCIPAL.user.id);
const syntheticOrganizationId = toSafeId<"organization">(
  SYNTHETIC_PRINCIPAL.org.id,
);
export const syntheticCredentialPrincipal = {
  userId: syntheticUserId,
  organizationId: syntheticOrganizationId,
} satisfies CredentialPrincipal;
const workspaceId = toSafeId<"workspace">("workspace_credential_issuer");

type IndependentRefusedIssuer = Exclude<
  keyof typeof USER_SESSION_CREDENTIAL_ISSUERS,
  | "session"
  | "cookieCache"
  | "collabRoom"
  | "oauth"
  | "apiKey"
  | "invitation"
  | "signedDownload"
>;
type IssuerProbe = (
  principal: typeof syntheticCredentialPrincipal,
) => Promise<void>;

const expectRefusal = async (operation: () => unknown) => {
  const rejection = await Promise.resolve()
    .then(operation)
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(rejection).toMatchObject({
    status: 403,
    code: "account_access_unavailable",
  });
};

const expectResultRefusal = <T>(result: Result<T, Error>) => {
  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result)) {
    expect(result.error).toMatchObject({
      status: 403,
      code: "account_access_unavailable",
    });
    return;
  }
  panic("Expected an unavailable response");
};

const withSignerSentinel = async (operation: () => Promise<unknown>) => {
  let signerCalled = false;
  setScopedSigningEnabledForTesting(() => true);
  setScopedS3ClientFactoryForTesting(() => {
    signerCalled = true;
    panic("The signing client was not expected to run");
  });
  try {
    await expectRefusal(operation);
    expect(signerCalled).toBe(false);
  } finally {
    resetAwsS3ClientForTesting();
  }
};

export const refusedCredentialIssuerProbes = {
  desktopAccount: async ({ userId, organizationId }) => {
    const result = await createDesktopLinkGrant({
      correlationId: "36ec3b21-08e7-4b87-9d68-fd54b3d23fe2",
      verifierHash: "a".repeat(64),
      deviceJkt: "A".repeat(43),
      userId,
      organizationId,
      db: {
        delete: () => {
          panic("The grant store was not expected to run");
        },
        insert: () => {
          panic("The grant store was not expected to run");
        },
      },
    });
    expectResultRefusal(result);
  },
  desktopEdit: async ({ userId, organizationId }) =>
    await expectRefusal(() =>
      createDesktopEditSessionToken({ userId, organizationId }),
    ),
  desktopHandoff: async ({ userId, organizationId }) =>
    await expectRefusal(() =>
      createDesktopEditHandoffToken({ userId, organizationId }),
    ),
  pdfSigning: async ({ userId, organizationId }) =>
    await expectRefusal(() =>
      createPdfSigningToken({ userId, organizationId }),
    ),
  signedUpload: async ({ userId, organizationId }) =>
    await withSignerSentinel(async () => {
      const result = await presignUploadUrl({
        userId,
        key: "tenant/fixture.pdf",
        expiresIn: 60,
        contentType: "application/pdf",
        contentLength: 1,
        sha256Base64: `${"A".repeat(43)}=`,
        scope: { organizationId },
      });
      if (Result.isError(result)) {
        throw result.error;
      }
      return result;
    }),
  agentRun: async ({ userId, organizationId }) => {
    await expectRefusal(async () =>
      mintAgentRunToken({
        userId,
        organizationId,
        runId: "run_credential_issuer",
        workspaceIds: [],
      }),
    );
  },
  agentDelegation: async ({ userId, organizationId }) => {
    await expectRefusal(async () =>
      mintInternalSessionCookieHeader({
        userId,
        organizationId,
      }),
    );
  },
  realtime: async ({ userId, organizationId }) => {
    await expectRefusal(() =>
      subscribe({
        userId,
        organizationId,
        sessionId: "synthetic-session-probe",
        workspaceId,
        signal: new AbortController().signal,
      }),
    );
    await expectRefusal(() =>
      subscribeUser({
        userId,
        organizationId,
        sessionId: "synthetic-session-probe",
        signal: new AbortController().signal,
      }),
    );
  },
  inboundEmail: async (principal) =>
    await expectRefusal(() => generateInboundAddressToken(principal)),
  confirmationCode: async () => {
    const result = await createConfirmationOtp({
      purpose: "delete-account",
      email: SYNTHETIC_PRINCIPAL.user.email,
    });
    expectResultRefusal(result);
    expectResultRefusal(
      await verifyConfirmationOtp({
        purpose: "two-factor-manage",
        email: SYNTHETIC_PRINCIPAL.user.email,
        code: "000000",
      }),
    );
    expectResultRefusal(
      await runConfirmedTransaction({
        confirmation: {
          purpose: "delete-account",
          email: SYNTHETIC_PRINCIPAL.user.email,
          code: "000000",
        },
        beforeConsume: () => {
          panic("The confirmation transaction was not expected to run");
        },
        afterConsume: () => {
          panic("The confirmation transaction was not expected to run");
        },
      }),
    );
  },
} satisfies Record<IndependentRefusedIssuer, IssuerProbe>;
