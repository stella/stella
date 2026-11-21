import type { PermissionInput } from "@stll/permissions";

export type McpSession = {
  userId: string;
  organizationId: string;
  scopes: string[];
  credential?:
    | { type: "agent_run"; runId: string }
    | {
        type: "oauth_client";
        clientId: string;
        grantId?: string;
        issuedAt: number;
      }
    /**
     * `permissions` is the key's own permission set, already checked to be a
     * subset of its owner's current role when the credential resolved. It rides
     * on the credential because it is the credential's attenuation, and the
     * authorization path ANDs it with the role
     * (`mcp/effective-authority.ts`). A key with no usable set never resolves,
     * so the field is required on this branch.
     */
    | {
        type: "machine_api_key" | "personal_api_key";
        id: string;
        name: string;
        permissions: PermissionInput;
      }
    | { type: "delegated_user" };
  /** Optional server-issued attenuation; absent means the full live access set. */
  workspaceIds?: string[];
  /**
   * The membership row an OAuth access token was issued under; the session
   * opens only while that row is the user's current membership. Absent on
   * credentials that carry no such claim.
   */
  memberId?: string;
};
