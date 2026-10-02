import { env } from "@/api/env";
import { checkDemoAccountAccess } from "@/api/lib/auth/demo-account-policy";

export const getDemoAccountConfig = () => ({
  email: env.DEMO_ACCOUNT_EMAIL,
  organizationId: env.DEMO_ACCOUNT_ORGANIZATION_ID,
});

export const checkConfiguredDemoAccountAccess = (
  options: Omit<Parameters<typeof checkDemoAccountAccess>[0], "config">,
) => checkDemoAccountAccess({ ...options, config: getDemoAccountConfig() });

export const checkDemoAccountOperation = (email: string) =>
  checkDemoAccountAccess({
    email,
    config: getDemoAccountConfig(),
    operation: "growth",
  });
