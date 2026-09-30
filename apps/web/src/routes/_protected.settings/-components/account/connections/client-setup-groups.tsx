import { useState } from "react";

import { Result } from "better-result";
import { useTranslations } from "use-intl";

import {
  MCP_ANONYMIZED_HTTP_PATH,
  MCP_HTTP_PATH,
  MCP_LAW_HTTP_PATH,
} from "@stll/api-contract";
import { copyToClipboard } from "@stll/clipboard";
import { Button } from "@stll/ui/button";
import {
  CaseLawIcon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  EyeOffIcon,
  KeyRoundIcon,
  ServerIcon,
  type LucideIcon,
} from "@stll/ui/icons";
import {
  List,
  ListGroup,
  ListGroupDescription,
  ListGroupHeader,
  ListGroupHeading,
  ListGroupTitle,
  ListItem,
  ListItemActions,
  ListItemContent,
  ListItemDescription,
  ListItemMedia,
  ListItemTitle,
} from "@stll/ui/list";
import { stellaToast } from "@stll/ui/toast";

import { getAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";

const CLI_INSTALL_COMMAND = "npm i -g @stll/cli";
const COPIED_FEEDBACK_MS = 1600;

type SetupRow = {
  id: string;
  icon: LucideIcon;
  title: string;
  /** Plain-language note; omitted when the value speaks for itself. */
  note?: string;
  value: string;
};

/** Everything needed to bring your own client: the MCP endpoints and the CLI.
 *  One-time setup, so it sits below the live connections and hides while the
 *  user searches. */
export const ClientSetupGroups = ({ apiOrigin }: { apiOrigin: string }) => {
  const t = useTranslations();
  const baseUrl = apiOrigin.replace(/\/$/u, "");

  const mcpRows: SetupRow[] = [
    {
      id: "mcp",
      icon: ServerIcon,
      title: t("settings.connections.mcpUrlLabel"),
      note: t("settings.connections.mcpFullNote"),
      value: `${baseUrl}${MCP_HTTP_PATH}`,
    },
    {
      id: "mcp-anonymized",
      icon: EyeOffIcon,
      title: t("settings.connections.mcpAnonymizedLabel"),
      note: t("settings.connections.mcpAnonymizedShortNote"),
      value: `${baseUrl}${MCP_ANONYMIZED_HTTP_PATH}`,
    },
    {
      id: "mcp-law",
      icon: CaseLawIcon,
      title: t("settings.connections.mcpLawLabel"),
      note: t("settings.connections.mcpLawShortNote"),
      value: `${baseUrl}${MCP_LAW_HTTP_PATH}`,
    },
  ];
  const cliRows: SetupRow[] = [
    {
      id: "cli-install",
      icon: DownloadIcon,
      title: t("settings.connections.cliInstallLabel"),
      value: CLI_INSTALL_COMMAND,
    },
    {
      id: "cli-login",
      icon: KeyRoundIcon,
      title: t("settings.connections.cliLoginLabel"),
      value: `stella auth login --server ${baseUrl}`,
    },
  ];

  return (
    <>
      <ListGroup aria-labelledby="connections-mcp">
        <ListGroupHeader>
          <ListGroupHeading>
            <ListGroupTitle id="connections-mcp">
              {t("settings.connections.mcpTitle")}
            </ListGroupTitle>
            <ListGroupDescription>
              {t("settings.connections.mcpSetupHint")}
            </ListGroupDescription>
          </ListGroupHeading>
        </ListGroupHeader>
        <SetupList rows={mcpRows} />
      </ListGroup>
      <ListGroup aria-labelledby="connections-cli">
        <ListGroupHeader>
          <ListGroupHeading>
            <ListGroupTitle id="connections-cli">
              {t("settings.connections.cliTitle")}
            </ListGroupTitle>
            <ListGroupDescription>
              {t("settings.connections.cliDescription")}
            </ListGroupDescription>
          </ListGroupHeading>
        </ListGroupHeader>
        <SetupList rows={cliRows} />
      </ListGroup>
    </>
  );
};

const SetupList = ({ rows }: { rows: readonly SetupRow[] }) => (
  <List>
    {rows.map((row) => (
      <ListItem key={row.id}>
        <ListItemMedia>
          <row.icon />
        </ListItemMedia>
        <ListItemContent>
          <ListItemTitle>{row.title}</ListItemTitle>
          {row.note === undefined ? (
            <ListItemDescription variant="code">
              {row.value}
            </ListItemDescription>
          ) : (
            <ListItemDescription>{row.note}</ListItemDescription>
          )}
        </ListItemContent>
        <ListItemActions>
          {row.note !== undefined && (
            <code
              className="bg-muted text-muted-foreground hidden max-w-64 truncate rounded-md px-2 py-1 font-mono text-xs md:block"
              dir="ltr"
              title={row.value}
            >
              {row.value}
            </code>
          )}
          <CopyValueButton value={row.value} />
        </ListItemActions>
      </ListItem>
    ))}
  </List>
);

/** Icon button that confirms in place (copy → check) and with a toast. */
const CopyValueButton = ({ value }: { value: string }) => {
  const t = useTranslations();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const result = await copyToClipboard(value);
    if (Result.isError(result)) {
      getAnalytics().captureError(result.error);
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
      return;
    }
    stellaToast.add({ title: t("common.copied"), type: "success" });
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, COPIED_FEEDBACK_MS);
  };

  return (
    <Button
      aria-label={t("common.copy")}
      onClick={() => {
        detached(copy(), "connections.copy-value");
      }}
      size="icon-sm"
      type="button"
      variant="ghost"
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
};
