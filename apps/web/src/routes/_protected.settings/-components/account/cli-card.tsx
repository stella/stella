import { useTranslations } from "use-intl";

import { Frame, FramePanel } from "@stll/ui/components/frame";

import { CopyField } from "@/routes/_protected.settings/-components/account/copy-field";

const CLI_INSTALL_COMMAND = "npm i -g @stll/cli";

type CliCardProps = {
  apiOrigin: string;
};

export const CliCard = ({ apiOrigin }: CliCardProps) => {
  const t = useTranslations();
  const loginCommand = `stella auth login --server ${apiOrigin.replace(/\/$/u, "")}`;

  return (
    <Frame>
      <FramePanel className="flex flex-col gap-4 p-1">
        <div className="space-y-1">
          <h2 className="text-sm font-medium">
            {t("settings.connections.cliTitle")}
          </h2>
          <p className="text-muted-foreground max-w-2xl text-sm">
            {t("settings.connections.cliDescription")}
          </p>
        </div>
        <CopyField
          label={t("settings.connections.cliInstallLabel")}
          value={CLI_INSTALL_COMMAND}
        />
        <CopyField
          label={t("settings.connections.cliLoginLabel")}
          value={loginCommand}
        />
        <p className="text-muted-foreground text-sm">
          {t("settings.connections.cliHelpHint")}
        </p>
      </FramePanel>
    </Frame>
  );
};
