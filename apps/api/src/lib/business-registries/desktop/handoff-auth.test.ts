import { panic, Result } from "better-result";
import { expect, test } from "bun:test";

import {
  DESKTOP_HANDOFF_FAILURE,
  DESKTOP_HANDOFF_PROTOCOL_HEADER,
  DESKTOP_HANDOFF_PROTOCOL_VERSION,
} from "@stll/api-contract/desktop-handoff";

import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import {
  claimFixtureDeviceProof,
  createDesktopDeviceSigner,
} from "@/api/tests/helpers/desktop-device-proof";

import { authorizeDesktopHandoff } from "./handoff-auth";
import type { DesktopHandoffAuthorizationDependencies } from "./handoff-auth";

const HANDOFF_TOKEN = "ab".repeat(32);
const KINDS = ["desktop_edit", "pdf_signing"] as const;
const requestWithProtocol = (protocol: string | null) =>
  new Request("http://localhost/redeem", {
    headers:
      protocol === null ? {} : { [DESKTOP_HANDOFF_PROTOCOL_HEADER]: protocol },
  });

test("each handoff records an actionable protocol refusal before answering", async () => {
  for (const kind of KINDS) {
    for (const protocol of [
      null,
      "",
      "0",
      "-1",
      "1.0",
      "1e0",
      "01",
      "invalid",
      "9007199254740992",
    ]) {
      const recorded: Parameters<
        DesktopHandoffAuthorizationDependencies["recordFailure"]
      >[0][] = [];
      const result = await authorizeDesktopHandoff(
        {
          kind,
          handoffToken: HANDOFF_TOKEN,
          request: requestWithProtocol(protocol),
        },
        {
          authorizeAccount: async () =>
            panic("unsupported protocol must not authenticate"),
          recordFailure: async (options) => {
            recorded.push(options);
            return true;
          },
        },
      );
      expect(recorded).toEqual([
        {
          kind,
          handoffToken: HANDOFF_TOKEN,
          reason: DESKTOP_HANDOFF_FAILURE.updateRequired,
        },
      ]);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toMatchObject({
          status: 426,
          code: DESKTOP_HANDOFF_FAILURE.updateRequired,
          retryable: false,
        });
      }
    }
  }
});

test("each supported handoff records an account refusal with the existing account message", async () => {
  for (const kind of KINDS) {
    for (const authorization of [undefined, "Bearer unrelated-credential"]) {
      const recorded: Parameters<
        DesktopHandoffAuthorizationDependencies["recordFailure"]
      >[0][] = [];
      const request = requestWithProtocol(
        String(DESKTOP_HANDOFF_PROTOCOL_VERSION),
      );
      if (authorization) {
        request.headers.set("authorization", authorization);
      }
      const result = await authorizeDesktopHandoff(
        { kind, request, handoffToken: HANDOFF_TOKEN },
        {
          authorizeAccount: authorizeDesktopAccount,
          recordFailure: async (options) => {
            recorded.push(options);
            return true;
          },
        },
      );
      expect(recorded).toEqual([
        {
          kind,
          handoffToken: HANDOFF_TOKEN,
          reason: DESKTOP_HANDOFF_FAILURE.accountRequired,
        },
      ]);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toMatchObject({
          status: 401,
          code: DESKTOP_HANDOFF_FAILURE.accountRequired,
          message: "Reconnect desktop to your account",
          retryable: false,
        });
      }
    }
  }
});

test("supported protocols retain the authenticated account identity without a failure write", async () => {
  const device = await createDesktopDeviceSigner();
  const identity = {
    consumedProof: await claimFixtureDeviceProof({
      request: await device.signRequest({
        request: requestWithProtocol(String(DESKTOP_HANDOFF_PROTOCOL_VERSION)),
        credential: "fixture-credential",
      }),
      deviceJkt: device.deviceJkt,
      keyId: "desktop-account-key",
      credential: "fixture-credential",
    }),
    keyId: "desktop-account-key",
    organizationId: mintAuthProviderId<"organization">(),
    userId: mintAuthProviderId<"user">(),
    scopedDb: async () =>
      panic("authorization must not access document content"),
  };
  for (const kind of KINDS) {
    for (const protocol of [
      DESKTOP_HANDOFF_PROTOCOL_VERSION,
      DESKTOP_HANDOFF_PROTOCOL_VERSION + 1,
    ]) {
      const result = await authorizeDesktopHandoff(
        {
          kind,
          handoffToken: HANDOFF_TOKEN,
          request: requestWithProtocol(String(protocol)),
        },
        {
          authorizeAccount: async () => Result.ok(identity),
          recordFailure: async () =>
            panic("authorized handoff must not record a failure"),
        },
      );
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toBe(identity);
      }
    }
  }
});

test("authorization availability errors preserve the pending handoff", async () => {
  const unavailable = new HandlerError({
    status: 503,
    message: "Registry authorization is unavailable",
  });
  const result = await authorizeDesktopHandoff(
    {
      kind: "pdf_signing",
      handoffToken: HANDOFF_TOKEN,
      request: requestWithProtocol(String(DESKTOP_HANDOFF_PROTOCOL_VERSION)),
    },
    {
      authorizeAccount: async () => Result.err(unavailable),
      recordFailure: async () =>
        panic("availability errors must not end a handoff"),
    },
  );
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error).toBe(unavailable);
  }
});

test("a failed status write surfaces a retryable service error", async () => {
  const result = await authorizeDesktopHandoff(
    {
      kind: "pdf_signing",
      handoffToken: HANDOFF_TOKEN,
      request: requestWithProtocol(null),
    },
    {
      authorizeAccount: async () =>
        panic("unsupported protocol must not authenticate"),
      recordFailure: async () => {
        throw new HandlerError({
          status: 503,
          message: "Status storage unavailable",
        });
      },
    },
  );
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error).toMatchObject({ status: 503, retryable: true });
  }
});
