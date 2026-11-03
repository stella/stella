import type { ComponentProps } from "react";

import { McpReconnectNoticeContent } from "@/components/chat/mcp-reconnect-notice";
import { AuthenticatedUserProvider } from "@/lib/authenticated-user-context";
import { toSafeId } from "@/lib/safe-id";

const candidates = [
  {
    id: toSafeId<"mcpUserConnection">("00000000-0000-4000-8000-000000000001"),
    slug: "registry-search",
    displayName: "Registry Search",
    authType: "oauth2",
    status: "needs_reauth",
    expiresAt: null,
  },
  {
    id: toSafeId<"mcpUserConnection">("00000000-0000-4000-8000-000000000002"),
    slug: "document-archive",
    displayName: "Document Archive",
    authType: "bearer",
    status: "needs_approval",
    expiresAt: null,
  },
  {
    id: toSafeId<"mcpUserConnection">("00000000-0000-4000-8000-000000000003"),
    slug: "team-records",
    displayName: "Team Records",
    authType: "bearer",
    status: "revoked",
    expiresAt: null,
  },
] as const satisfies ComponentProps<
  typeof McpReconnectNoticeContent
>["candidates"];

export const McpReconnectPlayground = () => (
  <section
    className="w-full max-w-2xl space-y-4 p-4"
    data-playground-section="mcp-reconnect"
  >
    <AuthenticatedUserProvider
      user={{
        activeOrganizationId: "mcp-reconnect-fixture-org",
        id: "mcp-reconnect-fixture-user",
        email: "member@example.test",
        image: null,
        name: "Member",
        preferredName: null,
        timezoneId: "UTC",
        wordEditShortcut: null,
      }}
    >
      <McpReconnectNoticeContent
        candidates={candidates}
        text="Use Registry Search, Document Archive and Team Records"
      />
    </AuthenticatedUserProvider>
  </section>
);
