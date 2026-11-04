import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  CHAT_CLOUD_RUN_TARGET,
  CHAT_RUN_TARGET_KIND,
  type ChatRunTarget,
} from "@stll/api-contract/chat-run-target";
import { BidiText } from "@stll/ui/bidi-text";
import {
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "@stll/ui/menu";

import {
  CHAT_LOCAL_HARNESS_NAMES,
  type ChatLocalHarnessOption,
  chatLocalHarnessOptions,
  runTargetValue,
} from "@/components/chat/chat-run-target-menu.logic";
import { localRunnersOptions } from "@/features/chat/queries";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { queryView } from "@/lib/query-view.logic";
import { MEDIUM_DATE_SHORT_TIME_FORMAT } from "@/lib/relative-time";

type UnavailableState = Exclude<
  ChatLocalHarnessOption["state"],
  "ready" | "limit_until"
>;

const UNAVAILABLE_LABEL_KEY = {
  needs_login: "chat.localRun.stateNeedsLogin",
  not_installed: "chat.localRun.stateNotInstalled",
  unsupported: "chat.localRun.stateUnsupported",
  offline: "chat.localRun.stateOffline",
} as const satisfies Record<UnavailableState, TranslationKey>;

type ChatRunTargetMenuProps = {
  activeOrganizationId: string;
  /** Reads the member's computers only while the menu is open. */
  enabled: boolean;
  selected: ChatRunTarget;
  onSelect: (target: ChatRunTarget) => void;
};

/**
 * The Run on choice of the Models submenu: stella's own models, or a coding
 * agent on the member's computer with the models it reports. Absent entirely
 * until the member's computers are known and the member may run turns there.
 */
export const ChatRunTargetMenu = ({
  activeOrganizationId,
  enabled,
  selected,
  onSelect,
}: ChatRunTargetMenuProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const runnersView = queryView(
    useQuery({
      ...localRunnersOptions(activeOrganizationId),
      enabled,
    }),
  );
  // Until the member's computers are known, and when they cannot be read,
  // the menu offers only stella's own models, as it does without the feature.
  // A thread already set to run on a computer always keeps the way back to
  // stella cloud, since stella's models are not listed while it runs there.
  const options =
    chatLocalHarnessOptions(
      runnersView.type === "items" ? runnersView.items : undefined,
    ) ?? (selected.kind === "local" ? [] : null);
  if (options === null) {
    return null;
  }
  const value = runTargetValue(selected);
  const choose = (target: ChatRunTarget) => {
    if (runTargetValue(target) !== value) {
      onSelect(target);
    }
  };

  const stateLabel = (option: ChatLocalHarnessOption) => {
    switch (option.state) {
      case "ready":
        return null;
      case "limit_until":
        return t("chat.localRun.stateLimitUntil", {
          time: format.dateTime(
            new Date(option.resetsAt),
            MEDIUM_DATE_SHORT_TIME_FORMAT,
          ),
        });
      case "needs_login":
      case "not_installed":
      case "unsupported":
      case "offline":
        return t(UNAVAILABLE_LABEL_KEY[option.state]);
      default:
        option satisfies never;
        return panic("Unknown harness state");
    }
  };

  return (
    <>
      <MenuRadioGroup value={value}>
        {/* The label names its group, so it lives inside it. */}
        <MenuGroupLabel>{t("chat.localRun.runOn")}</MenuGroupLabel>
        <MenuRadioItem
          onClick={() => choose(CHAT_CLOUD_RUN_TARGET)}
          value={CHAT_RUN_TARGET_KIND.cloud}
        >
          {t("chat.localRun.cloud")}
        </MenuRadioItem>
        {options.map((option) => {
          const name = t("chat.localRun.onThisComputer", {
            harness: CHAT_LOCAL_HARNESS_NAMES[option.harness],
          });
          if (option.state !== "ready") {
            return (
              <MenuItem disabled key={option.harness}>
                <span className="flex min-w-0 flex-col py-0.5">
                  <BidiText as="span" className="truncate">
                    {name}
                  </BidiText>
                  <span className="text-muted-foreground text-2xs">
                    {stateLabel(option)}
                  </span>
                </span>
              </MenuItem>
            );
          }
          const harnessSelected =
            selected.kind === "local" && selected.harness === option.harness;
          return (
            <MenuSub key={option.harness}>
              <MenuSubTrigger data-checked={harnessSelected || undefined}>
                <BidiText as="span" className="truncate">
                  {name}
                </BidiText>
              </MenuSubTrigger>
              <MenuSubPopup className="w-64">
                <MenuRadioGroup value={value}>
                  {option.models.map((model) => {
                    const target: ChatRunTarget = {
                      kind: "local",
                      harness: option.harness,
                      model: model.id,
                    };
                    return (
                      <MenuRadioItem
                        key={model.id}
                        onClick={() => choose(target)}
                        value={runTargetValue(target)}
                      >
                        <BidiText as="span" className="truncate">
                          {model.label}
                        </BidiText>
                      </MenuRadioItem>
                    );
                  })}
                </MenuRadioGroup>
              </MenuSubPopup>
            </MenuSub>
          );
        })}
      </MenuRadioGroup>
      {/* stella's own models follow only while the turns run there. */}
      {selected.kind === "cloud" && <MenuSeparator />}
    </>
  );
};
