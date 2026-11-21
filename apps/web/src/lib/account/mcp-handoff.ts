import { redirect } from "@tanstack/react-router";
import { panic, Result } from "better-result";
import * as v from "valibot";

import { mcpHandoffRedeemResultSchema } from "@stll/api-contract/mcp-web-handoff";

import { handoffNavigationDestination } from "@/lib/account/handoff-url";
import { authClient } from "@/lib/auth-client";
import { normalizeRedirectTo } from "@/lib/redirect";

declare global {
  var hasStellaHandoff: (() => boolean) | undefined;
  var takeStellaHandoff: (() => unknown) | undefined;
}

type HandoffConfirmation = {
  code: string;
  path: string;
  destination: string;
  email: string;
  organizationName: string;
};
let confirmation: HandoffConfirmation | undefined;

const redeem = async ({
  code,
  path,
  confirmation: confirmed,
}: {
  code: string;
  path: string;
  confirmation?: "confirmed";
}) => {
  const result = await Result.tryPromise(
    async () =>
      await authClient.$fetch<unknown>("/mcp-handoff/redeem", {
        method: "POST",
        body: { code, path, ...(confirmed ? { confirmation: confirmed } : {}) },
      }),
  );
  if (Result.isError(result)) {
    return { status: "refused" as const };
  }
  const parsed = v.safeParse(mcpHandoffRedeemResultSchema, result.value.data);
  return parsed.success ? parsed.output : { status: "refused" as const };
};

export const handoffConfirmation = () =>
  confirmation === undefined
    ? undefined
    : {
        email: confirmation.email,
        organizationName: confirmation.organizationName,
      };

export const finishHandoff = async () => {
  const pending = confirmation;
  if (!pending) {
    return;
  }
  const result = await redeem({ ...pending, confirmation: "confirmed" });
  confirmation = undefined;
  window.location.replace(
    handoffNavigationDestination(
      pending.destination,
      result.status === "redeemed" ? "redeemed" : "refused",
    ),
  );
};

export const cancelHandoff = () => {
  const path = confirmation?.destination ?? "/";
  confirmation = undefined;
  window.location.replace(path);
};

const prepareHandoff = async () => {
  const captured = window.takeStellaHandoff?.();
  const parsed = v.safeParse(
    v.object({ code: v.string(), path: v.string(), destination: v.string() }),
    captured,
  );
  if (!parsed.success) {
    return undefined;
  }
  const pending = parsed.output;
  const path = normalizeRedirectTo(pending.path);
  return {
    code: pending.code,
    path,
    destination: normalizeRedirectTo(pending.destination),
    result: await redeem({ code: pending.code, path }),
  };
};

let redemption: ReturnType<typeof prepareHandoff> | undefined;

// Runs at the root before any signed-in guard, including public law entry.
export const loadMcpHandoff = async () => {
  if (typeof window === "undefined") {
    return undefined;
  }
  redemption ??= prepareHandoff();
  const pending = await redemption;
  redemption = undefined;
  if (!pending) {
    return undefined;
  }
  const { path, result } = pending;
  switch (result.status) {
    case "needs_confirmation":
      confirmation = {
        code: pending.code,
        path,
        destination: pending.destination,
        email: result.email,
        organizationName: result.organizationName,
      };
      return redirect({ to: "/auth/handoff", replace: true });
    case "redeemed":
      return redirect({
        href: pending.destination,
        replace: true,
        reloadDocument: true,
      });
    case "refused":
      return redirect({
        href: handoffNavigationDestination(pending.destination, "refused"),
        replace: true,
        reloadDocument: true,
      });
    default:
      result satisfies never;
      return panic("Unhandled handoff status.");
  }
};

export const pendingHandoffPath = () => {
  if (typeof window === "undefined" || !window.hasStellaHandoff?.()) {
    return undefined;
  }
  return window.location.pathname + window.location.search;
};
