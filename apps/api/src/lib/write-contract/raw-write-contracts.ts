import type { ApiRouteKey } from "@/api/http/api-route-types";
import type { WriteContract } from "@/api/lib/write-contract/write-contract";

/**
 * Routes whose definitions no safe factory built declare their contract here,
 * by the method and path the route table mounts them at. The keys are typed
 * against the mounted routes, so this list lives apart from the contract
 * helpers, which every handler module loads without the route table.
 */
export const RAW_WRITE_CONTRACTS: ReadonlyMap<ApiRouteKey, WriteContract> =
  new Map([
    [
      "DELETE /mcp",
      {
        contract: "patch",
      },
    ],
    [
      "DELETE /mcp-anonymized",
      {
        contract: "patch",
      },
    ],
    [
      "DELETE /mcp-documents",
      {
        contract: "patch",
      },
    ],
    [
      "DELETE /mcp-law",
      {
        contract: "patch",
      },
    ],
    [
      "DELETE /mcp/advanced",
      {
        contract: "patch",
      },
    ],
    [
      "POST /api/auth/*",
      {
        contract: "patch",
      },
    ],
    [
      "POST /mcp",
      {
        contract: "patch",
      },
    ],
    [
      "POST /mcp-anonymized",
      {
        contract: "patch",
      },
    ],
    [
      "POST /mcp-documents",
      {
        contract: "patch",
      },
    ],
    [
      "POST /mcp-law",
      {
        contract: "patch",
      },
    ],
    [
      "POST /mcp/advanced",
      {
        contract: "patch",
      },
    ],
    [
      "POST /public/feedback",
      {
        contract: "patch",
      },
    ],
    [
      "POST /smoke/session",
      {
        contract: "patch",
      },
    ],
    [
      "POST /synthetic/session",
      {
        contract: "patch",
      },
    ],
    [
      "POST /usage/hosted/webhook",
      {
        contract: "patch",
      },
    ],
    [
      "POST /v1/desktop-edit-handoffs/:handoffId/opened",
      {
        contract: "patch",
      },
    ],
    [
      "POST /v1/desktop-edit-handoffs/redeem",
      {
        contract: "patch",
      },
    ],
    [
      "POST /v1/desktop-edit-sessions/:sessionId/checkpoint",
      {
        contract: "replace",
        precondition: {
          type: "deferred",
          baselineId: "POST /v1/desktop-edit-sessions/:sessionId/checkpoint",
        },
      },
    ],
    [
      "POST /v1/desktop-edit-sessions/:sessionId/finalize",
      {
        contract: "patch",
      },
    ],
    [
      "POST /v1/desktop-edit-sessions/:sessionId/respond-takeover",
      {
        contract: "patch",
      },
    ],
    [
      "POST /v1/dev/clean",
      {
        contract: "patch",
      },
    ],
    [
      "POST /v1/dev/clear-cache",
      {
        contract: "patch",
      },
    ],
    [
      "POST /v1/dev/public-law-connection",
      {
        contract: "patch",
      },
    ],
    [
      "POST /v1/dev/rebuild-search",
      {
        contract: "patch",
      },
    ],
    [
      "POST /v1/dev/seed",
      {
        contract: "patch",
      },
    ],
    [
      "POST /v1/dev/seed-firm-knowledge",
      {
        contract: "patch",
      },
    ],
  ]);
