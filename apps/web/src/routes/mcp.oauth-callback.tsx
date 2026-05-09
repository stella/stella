import { useEffect } from "react";

import { Button } from "@stll/ui/components/button";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stll/ui/components/frame";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { pageTitle } from "@/lib/page-title";

const searchSchema = v.object({
  status: v.picklist(["connected", "error"]),
  slug: v.optional(v.string()),
  reason: v.optional(v.string()),
});

export const Route = createFileRoute("/mcp/oauth-callback")({
  validateSearch: searchSchema,
  head: () => ({
    meta: [{ title: pageTitle("knowledge.sections.mcp.title") }],
  }),
  component: McpOAuthCallbackPage,
});

function McpOAuthCallbackPage() {
  const t = useTranslations();
  const status = Route.useSearch({ select: (search) => search.status });
  const slug = Route.useSearch({ select: (search) => search.slug });
  const reason = Route.useSearch({ select: (search) => search.reason });

  useEffect(() => {
    const message =
      status === "connected"
        ? `mcp:connected:${slug ?? ""}`
        : `mcp:error:${reason ?? "unexpected"}`;

    // SAFETY: lib.dom types `window.opener` as `any` because the
    // opener may be a Window from any origin. We post to our own
    // origin only, so narrowing to the postMessage surface is safe.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const opener = window.opener as Pick<Window, "postMessage"> | null;
    if (opener !== null) {
      opener.postMessage(message, window.location.origin);
      window.close();
    }
  }, [status, slug, reason]);

  const isError = status === "error";

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Frame className="w-full max-w-sm">
        <FrameHeader>
          <FrameTitle>
            {isError
              ? t("knowledge.mcp.errorTitle")
              : t("knowledge.mcp.connectedToast")}
          </FrameTitle>
          {isError ? (
            <FrameDescription>
              {t("knowledge.mcp.errorDescription")}
            </FrameDescription>
          ) : null}
        </FrameHeader>
        <FramePanel>
          <Link to="/knowledge/mcp">
            <Button className="w-full" type="button">
              {t("common.close")}
            </Button>
          </Link>
        </FramePanel>
      </Frame>
    </div>
  );
}
