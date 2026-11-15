import type { SessionHandlerConfig } from "@/api/lib/api-handlers";

type OrganizationCreationCapability = {
  accountAccess: "account-control";
  contract: "patch";
  access: "write";
  mcp: {
    type: "capability";
    reason: "organization_management";
    consumesServices: false;
  };
};

type RejectedSessionConfig<T> = T extends SessionHandlerConfig ? never : true;

export const missingAccountScopeRejected: RejectedSessionConfig<OrganizationCreationCapability> = true;
export const organizationScopeRejected: RejectedSessionConfig<
  OrganizationCreationCapability & { accountScope: "stella:admin_write" }
> = true;

export const declaredAccountScope = {
  accountAccess: "account-control",
  contract: "patch",
  access: "write",
  accountScope: "stella:organization_create",
  mcp: {
    type: "capability",
    reason: "organization_management",
    consumesServices: false,
  },
} as const satisfies SessionHandlerConfig;
