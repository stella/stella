import { logger } from "@/api/lib/observability/logger";
import { emitRateLimitRejectedMetric } from "@/api/lib/observability/request-metrics";

export const BUDGET_NAMES = [
  "api.address",
  "api.agent_auth.address",
  "api.agent_auth_confirm.address",
  "api.folio_collab.address",
  "api.delete_account_otp.address",
  "api.two_factor_manage_otp.address",
  "api.hosted_usage_webhook.address",
  "api.translate.address",
  "api.upload.address",
  "api.public_sanctions.address",
  "demo.action.user",
  "auth.framework.address",
  "auth.sign_up.address",
  "auth.verify_otp.address",
  "auth.forget_password.address",
  "auth.reset_password.address",
  "auth.two_factor.address",
  "auth.account",
  "auth.otp.account",
  "auth.otp.demo_account",
  "auth.password.account",
  "auth.token.user_client",
  "auth.token.address",
  "auth.authorize.user",
  "auth.authorize.address",
  "auth.register.user",
  "auth.register.client",
  "auth.register.address",
  "auth.sign_in.email.account",
  "auth.sign_in.email.address",
  "auth.sign_in.otp.account",
  "auth.sign_in.otp.address",
  "auth.otp.send.account",
  "auth.otp.send.address",
  "auth.social.address",
  "auth.social.user",
  "mcp.transport.bearer",
  "mcp.transport.address",
  "mcp.authentication.address",
  "mcp.capability.user",
  "mcp.translate.user",
  "mcp.upload.user",
  "mcp.gateway.user_client",
  "skills.source.user",
  "skills.source.address",
] as const;

export type BudgetName = (typeof BUDGET_NAMES)[number];
export type BudgetKeyKind =
  | "user"
  | "client"
  | "account"
  | "bearer"
  | "address";
export type BudgetObservation = { name: BudgetName; keyKind: BudgetKeyKind };

/** Only the bounded budget vocabulary crosses the telemetry boundary. */
export const recordBudgetRejection = ({
  name,
  keyKind,
  windowMs,
}: BudgetObservation & { windowMs: number }): void => {
  logger.warn("rate_limit.rejected", {
    budget: name,
    "budget.keyKind": keyKind,
    "budget.windowMs": windowMs,
    "http.status_code": 429,
  });
  emitRateLimitRejectedMetric(name);
};
