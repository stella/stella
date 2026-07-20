import { useState } from "react";

import { createFileRoute, redirect } from "@tanstack/react-router";
import { Result } from "better-result";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Button } from "@stll/ui/components/button";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stll/ui/components/frame";
import { Input } from "@stll/ui/components/input";
import { Label } from "@stll/ui/components/label";
import { stellaToast } from "@stll/ui/components/toast";

import { env } from "@/env";
import { authClient } from "@/lib/auth";
import { detached } from "@/lib/detached";
import { APIError } from "@/lib/errors/api";
import { fetchWithTimeout } from "@/lib/fetch";
import { pageTitle } from "@/lib/page-title";
import { loadAuthContext } from "@/routes/-auth-context";

const searchSchema = v.object({
  user_code: v.optional(v.string()),
});

export const Route = createFileRoute("/agent-claim")({
  validateSearch: searchSchema,
  beforeLoad: async ({ context, location }) => {
    const authContext = await loadAuthContext(context.queryClient);

    if (!authContext.session) {
      throw redirect({
        to: "/auth",
        search: {
          redirectTo: location.pathname + location.searchStr,
        },
        replace: true,
      });
    }

    return authContext;
  },
  head: () => ({
    meta: [{ title: pageTitle("agentClaim.title") }],
  }),
  component: AgentClaimPage,
});

function AgentClaimPage() {
  const t = useTranslations();
  const initialUserCode = Route.useSearch({
    select: (search) => search.user_code ?? "",
  });
  const activeOrganizationId = Route.useRouteContext({
    select: (ctx) => ctx.session?.activeOrganizationId ?? null,
  });
  const { data: organizations } = authClient.useListOrganizations();

  const [userCode, setUserCode] = useState(initialUserCode);
  const [status, setStatus] = useState<ClaimStatus>("idle");

  const organizationName =
    organizations?.find(
      (organization) => organization.id === activeOrganizationId,
    )?.name ?? null;

  const handleApprove = async () => {
    const trimmedCode = userCode.trim();
    if (trimmedCode.length === 0) {
      return;
    }

    setStatus("pending");

    const result = await Result.tryPromise(
      async () => await confirmAgentClaim(trimmedCode),
    );

    if (Result.isError(result)) {
      setStatus("idle");
      stellaToast.add({ title: t("agentClaim.error"), type: "error" });
      return;
    }

    if (result.value.status === "claimed") {
      setStatus("claimed");
      return;
    }

    setStatus("idle");
    if (result.value.status === "not_found") {
      stellaToast.add({ title: t("agentClaim.errorNotFound"), type: "error" });
      return;
    }
    if (result.value.status === "expired") {
      stellaToast.add({ title: t("agentClaim.errorExpired"), type: "error" });
      return;
    }
    stellaToast.add({ title: t("agentClaim.errorInvalid"), type: "error" });
  };

  if (status === "claimed") {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Frame className="w-full max-w-sm">
          <FrameHeader>
            <FrameTitle>{t("agentClaim.connectedTitle")}</FrameTitle>
            <FrameDescription>
              {t("agentClaim.connectedDescription")}
            </FrameDescription>
          </FrameHeader>
        </Frame>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center">
      <Frame className="w-full max-w-sm">
        <FrameHeader>
          <FrameTitle>{t("agentClaim.title")}</FrameTitle>
          <FrameDescription>{t("agentClaim.description")}</FrameDescription>
        </FrameHeader>
        <FramePanel className="flex flex-col gap-4">
          {organizationName ? (
            <div className="flex flex-col gap-1">
              <p className="text-muted-foreground text-sm">
                {t("common.organization")}
              </p>
              <p className="text-sm font-medium">{organizationName}</p>
            </div>
          ) : null}
          <div className="flex flex-col gap-1">
            <p className="text-muted-foreground text-sm">
              {t("agentClaim.access")}
            </p>
            <p className="text-sm font-medium">
              {t("agentClaim.accessReadSearch")}
            </p>
          </div>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              detached(handleApprove(), "AgentClaimPage");
            }}
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="agent-claim-code-input">
                {t("agentClaim.codeLabel")}
              </Label>
              <Input
                autoComplete="off"
                autoFocus
                id="agent-claim-code-input"
                maxLength={32}
                placeholder={t("agentClaim.codePlaceholder")}
                value={userCode}
                onChange={(event) => setUserCode(event.target.value)}
              />
            </div>
            <Button
              className="w-full"
              disabled={status === "pending" || userCode.trim().length === 0}
              loading={status === "pending"}
              type="submit"
            >
              {t("agentClaim.approve")}
            </Button>
          </form>
        </FramePanel>
      </Frame>
    </div>
  );
}

type ClaimStatus = "idle" | "pending" | "claimed";

type ConfirmResult =
  | { status: "claimed" }
  | { status: "not_found" }
  | { status: "expired" }
  | { status: "invalid" };

// The confirm endpoint is mounted at the API root (not under /v1), so it is
// absent from the `eden.v1` treaty. Call it directly; the session cookie is
// sent via `credentials: "include"`.
const confirmAgentClaim = async (userCode: string): Promise<ConfirmResult> => {
  const response = await fetchWithTimeout(
    `${env.VITE_API_URL}/agent/identity/confirm`,
    {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_code: userCode }),
      timeoutMs: 10_000,
    },
  );

  if (response.ok) {
    return { status: "claimed" };
  }
  if (response.status === 404) {
    return { status: "not_found" };
  }
  if (response.status === 409) {
    return { status: "expired" };
  }
  if (response.status === 422) {
    return { status: "invalid" };
  }

  throw new APIError({
    status: response.status,
    message: `Unexpected confirm response: ${response.status}`,
  });
};
