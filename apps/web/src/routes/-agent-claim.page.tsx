import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { AGENT_CLAIM_CODE_MAX_LENGTH } from "@stll/api-contract/limits";
import { fetchWithTimeout } from "@stll/fetch";
import { Button } from "@stll/ui/button";
import { Form } from "@stll/ui/form";
import { Input } from "@stll/ui/input";

import { browserApiRootUrl } from "@/lib/api-url";
import { detached } from "@/lib/detached";
import { APIError } from "@/lib/errors/api";
import { notifyUserError, notifyUserProblem } from "@/lib/errors/user-toast";
import { organizationListOptions } from "@/lib/organization/queries";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";

import { AgentClaimConnected } from "./-agent-claim-connected";
import {
  AGENT_CLAIM_CODE_ID,
  AgentClaimDetail,
  AgentClaimFields,
  AgentClaimOrganizationPending,
  AgentClaimShell,
} from "./-agent-claim.pending";

const routeApi = getRouteApi("/agent-claim");

export function AgentClaimPage() {
  const t = useTranslations();
  const initialUserCode = routeApi.useSearch({
    select: (search) => search.user_code ?? "",
  });
  const activeOrganizationId = routeApi.useRouteContext({
    select: (ctx) => ctx.session?.activeOrganizationId ?? null,
  });
  const userId = routeApi.useRouteContext({ select: (ctx) => ctx.userId });
  const organizationsView = queryView(
    useQuery(organizationListOptions(userId)),
  );
  useQueryViewError(organizationsView, "AgentClaimPage:query");
  const organizations =
    organizationsView.type === "items" ? organizationsView.items : undefined;

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

    const result = await confirmAgentClaim(trimmedCode);

    if (Result.isError(result)) {
      setStatus("idle");
      notifyUserError(result.error, t("agentClaim.error"));
      return;
    }

    if (result.value.status === "claimed") {
      setStatus("claimed");
      return;
    }

    setStatus("idle");
    if (result.value.status === "not_found") {
      notifyUserProblem(t("agentClaim.errorNotFound"));
      return;
    }
    if (result.value.status === "expired") {
      notifyUserProblem(t("agentClaim.errorExpired"));
      return;
    }
    notifyUserProblem(t("agentClaim.errorInvalid"));
  };

  if (status === "claimed") {
    return <AgentClaimConnected organizationName={organizationName} />;
  }

  let organization = null;
  if (organizationsView.type === "pending" && activeOrganizationId !== null) {
    organization = <AgentClaimOrganizationPending />;
  } else if (organizationName) {
    organization = (
      <AgentClaimDetail
        label={t("common.organization")}
        value={organizationName}
      />
    );
  }

  return (
    <AgentClaimShell
      access={
        <AgentClaimDetail
          label={t("agentClaim.access")}
          value={t("agentClaim.accessReadSearch")}
        />
      }
      description={t("agentClaim.description")}
      form={
        <Form
          onSubmit={(event) => {
            event.preventDefault();
            detached(handleApprove(), "agent-claim.approve");
          }}
        >
          <AgentClaimFields
            code={
              <Input
                autoComplete="off"
                autoFocus
                id={AGENT_CLAIM_CODE_ID}
                maxLength={AGENT_CLAIM_CODE_MAX_LENGTH}
                placeholder={t("agentClaim.codePlaceholder")}
                value={userCode}
                onChange={(event) => setUserCode(event.target.value)}
              />
            }
            label={t("agentClaim.codeLabel")}
            submit={
              <Button
                className="w-full"
                disabled={status === "pending" || userCode.trim().length === 0}
                loading={status === "pending"}
                type="submit"
              >
                {t("agentClaim.approve")}
              </Button>
            }
          />
        </Form>
      }
      organization={organization}
      title={t("agentClaim.title")}
    />
  );
}

type ClaimStatus = "idle" | "pending" | "claimed";

type ConfirmResult =
  | { status: "claimed" }
  | { status: "not_found" }
  | { status: "expired" }
  | { status: "invalid" };

// The confirm endpoint is mounted at the API root (not under /v1), so it is
// outside `api`. Call it directly; the session cookie is
// sent via `credentials: "include"`.
const confirmAgentClaim = async (
  userCode: string,
): Promise<Result<ConfirmResult, Error>> => {
  const result = await Result.tryPromise(
    async () =>
      await fetchWithTimeout(browserApiRootUrl("/agent/identity/confirm"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user_code: userCode }),
        timeout: { type: "headers", ms: 10_000 },
      }),
  );
  if (Result.isError(result)) {
    return Result.err(result.error);
  }

  const response = result.value;
  if (response.ok) {
    return Result.ok({ status: "claimed" });
  }
  if (response.status === 404) {
    return Result.ok({ status: "not_found" });
  }
  if (response.status === 409) {
    return Result.ok({ status: "expired" });
  }
  if (response.status === 422) {
    return Result.ok({ status: "invalid" });
  }

  return Result.err(
    new APIError({
      status: response.status,
      message: `Unexpected confirm response: ${response.status}`,
    }),
  );
};
