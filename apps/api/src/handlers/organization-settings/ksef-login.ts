import { Result } from "better-result";
import { eq } from "drizzle-orm";
import * as v from "valibot";

import { parseNip } from "@stll/invoicing";
import type { KsefTransport } from "@stll/invoicing/ksef";

import { organizationSettings } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  authenticatorFromLogin,
  certificateMetadata,
  importKsefSigningKey,
  KSEF_ENVIRONMENTS,
} from "@/api/lib/ksef-login";
import { encryptKsefLogin } from "@/api/lib/ksef-login-crypto";
import { safeOutboundFetchBytes } from "@/api/lib/safe-outbound-fetch";

const bodySchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("token"),
    target: v.picklist(KSEF_ENVIRONMENTS),
    nip: v.pipe(v.string(), v.maxLength(10)),
    token: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(4096),
      v.brand("Secret"),
    ),
  }),
  v.strictObject({
    kind: v.literal("certificate"),
    target: v.picklist(KSEF_ENVIRONMENTS),
    nip: v.pipe(v.string(), v.maxLength(10)),
    certificate: v.pipe(v.string(), v.maxLength(32_000)),
    privateKey: v.pipe(v.string(), v.maxLength(32_000), v.brand("Secret")),
  }),
]);
const baseConfig = {
  contract: "patch",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  mcp: { type: "internal", reason: "provider_secret" },
} satisfies HandlerConfig;
const ksefTransport =
  (permit: ReturnType<typeof grantThirdPartyOutboundPermit>): KsefTransport =>
  async ({ method, url, headers, body }) =>
    (
      await safeOutboundFetchBytes({
        url,
        method,
        headers,
        body,
        maxBytes: 2_000_000,
        timeout: { type: "headers", ms: 20_000 },
        permit,
      })
    ).map((response) => ({
      status: response.status,
      headers: response.headers,
      body: new Uint8Array(response.body),
    }));

export const saveKsefLogin = createSafeRootHandler(
  { ...baseConfig, body: bodySchema },
  async function* ({ safeDb, session, body, recordAuditEvent }) {
    const transport = ksefTransport(grantThirdPartyOutboundPermit());
    const nip = parseNip(body.nip);
    if (nip === null || nip !== body.nip) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "NIP must be exactly 10 digits with a valid checksum.",
        }),
      );
    }
    const login =
      body.kind === "token"
        ? ({ kind: body.kind, token: body.token } as const)
        : ({
            kind: body.kind,
            certificate: body.certificate,
            privateKey: body.privateKey,
          } as const);
    let metadata: ReturnType<typeof certificateMetadata> | undefined;
    if (body.kind === "certificate") {
      metadata = certificateMetadata(body.certificate);
      if (metadata.isErr()) {
        return Result.err(
          new HandlerError({ status: 400, message: metadata.error.message }),
        );
      }
      const key = await importKsefSigningKey(body.privateKey);
      if (key.isErr()) {
        return Result.err(
          new HandlerError({ status: 400, message: key.error.message }),
        );
      }
    }
    const built = await authenticatorFromLogin({
      login,
      target: body.target,
      nip,
      transport,
    });
    if (built.isErr()) {
      return Result.err(
        new HandlerError({ status: 400, message: built.error.message }),
      );
    }
    const authenticated = await built.value.getAccessToken();
    if (authenticated.isErr()) {
      return Result.err(
        new HandlerError({ status: 400, message: authenticated.error.message }),
      );
    }
    // no-secret-in-log-sink: serialized only into the encryption envelope.
    const encrypted = await encryptKsefLogin(
      session.activeOrganizationId,
      login,
    );
    const cert = metadata?.isOk() ? metadata.value : undefined;
    yield* Result.await(
      safeDb(async (tx) => {
        await tx
          .insert(organizationSettings)
          .values({
            id: createSafeId<"organizationSettings">(),
            organizationId: session.activeOrganizationId,
            ksefLoginEncrypted: encrypted.ciphertext,
            ksefLoginIv: encrypted.iv,
            ksefLoginKind: body.kind,
            ksefLoginTarget: body.target,
            ksefLoginNip: nip,
            ksefCertificateSubject: cert?.subject,
            ksefCertificateValidFrom: cert?.validFrom,
            ksefCertificateValidTo: cert?.validTo,
            ksefLoginSetAt: new Date(),
            ksefLoginSetBy: session.id,
          })
          .onConflictDoUpdate({
            target: organizationSettings.organizationId,
            set: {
              ksefLoginEncrypted: encrypted.ciphertext,
              ksefLoginIv: encrypted.iv,
              ksefLoginKind: body.kind,
              ksefLoginTarget: body.target,
              ksefLoginNip: nip,
              ksefCertificateSubject: cert?.subject ?? null,
              ksefCertificateValidFrom: cert?.validFrom ?? null,
              ksefCertificateValidTo: cert?.validTo ?? null,
              ksefLoginSetAt: new Date(),
              ksefLoginSetBy: session.id,
              updatedAt: new Date(),
            },
          });
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
          resourceId: session.activeOrganizationId,
          metadata: {
            field: "ksef_login",
            change: "set",
            kind: body.kind,
            target: body.target,
            nip,
          },
        });
      }),
    );
    return Result.ok({
      configured: true,
      kind: body.kind,
      target: body.target,
      nip,
      certificateSubject: cert?.subject ?? null,
      certificateValidFrom: cert?.validFrom ?? null,
      certificateValidTo: cert?.validTo ?? null,
    });
  },
);

export const readKsefLogin = createSafeRootHandler(
  baseConfig,
  async function* ({ safeDb, session }) {
    const row = yield* Result.await(
      safeDb((tx) =>
        tx.query.organizationSettings.findFirst({
          where: { organizationId: { eq: session.activeOrganizationId } },
          columns: {
            ksefLoginKind: true,
            ksefLoginTarget: true,
            ksefLoginNip: true,
            ksefCertificateSubject: true,
            ksefCertificateValidFrom: true,
            ksefCertificateValidTo: true,
            ksefLoginSetAt: true,
            ksefLoginSetBy: true,
          },
        }),
      ),
    );
    return Result.ok(
      row?.ksefLoginKind
        ? {
            configured: true,
            kind: row.ksefLoginKind,
            target: row.ksefLoginTarget,
            nip: row.ksefLoginNip,
            certificateSubject: row.ksefCertificateSubject,
            certificateValidFrom: row.ksefCertificateValidFrom,
            certificateValidTo: row.ksefCertificateValidTo,
            setAt: row.ksefLoginSetAt,
            setBy: row.ksefLoginSetBy,
          }
        : { configured: false },
    );
  },
);

export const deleteKsefLogin = createSafeRootHandler(
  baseConfig,
  async function* ({ safeDb, session, recordAuditEvent }) {
    yield* Result.await(
      safeDb(async (tx) => {
        await tx
          .update(organizationSettings)
          .set({
            ksefLoginEncrypted: null,
            ksefLoginIv: null,
            ksefLoginKind: null,
            ksefLoginTarget: null,
            ksefLoginNip: null,
            ksefCertificateSubject: null,
            ksefCertificateValidFrom: null,
            ksefCertificateValidTo: null,
            ksefLoginSetAt: null,
            ksefLoginSetBy: null,
            updatedAt: new Date(),
          })
          .where(
            eq(
              organizationSettings.organizationId,
              session.activeOrganizationId,
            ),
          );
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
          resourceId: session.activeOrganizationId,
          metadata: { field: "ksef_login", change: "deleted" },
        });
      }),
    );
    return Result.ok({ configured: false });
  },
);
