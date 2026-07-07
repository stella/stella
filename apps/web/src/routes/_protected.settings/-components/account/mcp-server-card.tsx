import { useTranslations } from "use-intl";

import { Frame, FramePanel } from "@stll/ui/components/frame";

import { CopyField } from "@/components/copy-field";

// Mirrors `MCP_HTTP_PATH` / `MCP_ANONYMIZED_HTTP_PATH` in
// `apps/api/src/mcp/constants.ts`. Not imported directly: that module pulls
// in the server-only `@/api/env`, which is unsafe to bundle into the
// browser build.
const MCP_HTTP_PATH = "/mcp";
const MCP_ANONYMIZED_HTTP_PATH = "/mcp-anonymized";

type McpServerCardProps = {
  apiOrigin: string;
};

export const McpServerCard = ({ apiOrigin }: McpServerCardProps) => {
  const t = useTranslations();
  const baseUrl = apiOrigin.replace(/\/$/u, "");
  const mcpUrl = `${baseUrl}${MCP_HTTP_PATH}`;
  const anonymizedUrl = `${baseUrl}${MCP_ANONYMIZED_HTTP_PATH}`;

  return (
    <Frame>
      <FramePanel className="flex flex-col gap-4 p-1">
        <div className="space-y-1">
          <h2 className="text-sm font-medium">
            {t("settings.connections.mcpTitle")}
          </h2>
          <p className="text-muted-foreground max-w-2xl text-sm">
            {t("settings.connections.mcpDescription")}
          </p>
        </div>
        <CopyField
          label={t("settings.connections.mcpUrlLabel")}
          value={mcpUrl}
        />
        <p className="text-muted-foreground text-sm">
          {t("settings.connections.mcpAnonymizedNote")}
        </p>
        <CopyField
          label={t("settings.connections.mcpAnonymizedLabel")}
          value={anonymizedUrl}
        />
        <ol className="text-muted-foreground list-decimal space-y-1 ps-4 text-sm">
          <li>{t("settings.connections.mcpStep1")}</li>
          <li>{t("settings.connections.mcpStep2")}</li>
          <li>{t("settings.connections.mcpStep3")}</li>
        </ol>
      </FramePanel>
    </Frame>
  );
};
