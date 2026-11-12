import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  CHAT_CLOUD_RUN_TARGET,
  CHAT_RUN_TARGET_KIND,
  type ChatLocalRunHarness,
  type ChatRunTarget,
} from "@stll/api-contract/chat-run-target";
import { DESKTOP_RUNNER_LINKED_FOLDER_STATE } from "@stll/api-contract/desktop-runner";
import { BidiText } from "@stll/ui/bidi-text";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "@stll/ui/menu";
import { TruncatedText } from "@stll/ui/truncated-text";

import {
  CHAT_LOCAL_HARNESS_NAMES,
  CHAT_OWN_FOLDER_VALUE,
  type ChatLocalFolderOption,
  chatLocalFolderOptions,
  type ChatLocalHarnessOption,
  chatLocalHarnessOptions,
  LOCAL_RUN_PERMISSION_KEYS,
  type LocalRunFolderProblem,
  localRunMaxApprovals,
  localRunTargetFor,
  type LocalRunTargetState,
  type PermissionAvailability,
  permissionView,
  runFolderValue,
  runTargetValue,
  sameRunTarget,
  withRunFolder,
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
  unavailable: "chat.localRun.stateUnavailable",
  offline: "chat.localRun.stateOffline",
} as const satisfies Record<UnavailableState, TranslationKey>;

/** Why a linked folder cannot take a turn now. */
const FOLDER_PROBLEM_KEY = {
  offline: "chat.localRun.folderStateOffline",
  moved: "chat.localRun.folderStateMoved",
  protected: "chat.localRun.folderStateProtected",
  unreadable: "chat.localRun.folderStateUnreadable",
  computer_offline: "chat.localRun.stateOffline",
  unlinked: "chat.localRun.folderStateUnlinked",
} as const satisfies Record<LocalRunFolderProblem, TranslationKey>;

/** Why a permission mode cannot be chosen, in its description's place. */
const UNAVAILABLE_PERMISSION_KEY = {
  computer: "chat.localRun.permissionUnavailable",
  organization: "chat.localRun.permissionAboveLimit",
} as const satisfies Record<
  Exclude<PermissionAvailability, "available">,
  TranslationKey
>;

/** How a harness that runs in one mode behaves, said once in its place. */
const FIXED_PERMISSION_KEY = {
  codex: "chat.localRun.permissionSandboxed",
  "claude-code": "chat.localRun.permissionAskDescription",
} as const satisfies Record<ChatLocalRunHarness, TranslationKey>;

/**
 * Why a harness cannot take a turn now, as the Run on menu and the composer
 * bar both say it; `null` while it can.
 */
const useHarnessStateLabel = () => {
  const t = useTranslations();
  const format = useFormatter();
  return (option: ChatLocalHarnessOption): string | null => {
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
      case "unavailable":
      case "offline":
        return t(UNAVAILABLE_LABEL_KEY[option.state]);
      default:
        option satisfies never;
        return panic("Unknown harness state");
    }
  };
};

/**
 * Why the member's computers cannot take a turn on the chosen target now,
 * as the composer bar says it; `null` while they can.
 */
export const useLocalRunTargetStateLabel = () => {
  const t = useTranslations();
  const harnessLabel = useHarnessStateLabel();
  return (state: LocalRunTargetState): string | null => {
    switch (state.type) {
      case "ready":
        return null;
      case "harness":
        return harnessLabel(state.option);
      case "model_unavailable":
        return t("chat.localRun.stateModelUnavailable");
      case "not_allowed":
        return t("chat.localRun.stateUnavailable");
      case "folder":
        return t(FOLDER_PROBLEM_KEY[state.problem]);
      case "folder_pending":
        return t("chat.localRun.folderStatePending");
      default:
        state satisfies never;
        return panic("Unknown local run target state");
    }
  };
};

type ChatRunTargetMenuProps = {
  activeOrganizationId: string;
  /** Reads the member's computers only while the menu is open. */
  enabled: boolean;
  selected: ChatRunTarget;
  onSelect: (target: ChatRunTarget) => void;
};

/**
 * The Run on choice of the Models submenu: stella's own models, or a coding
 * agent on the member's computer with the models it reports, and then how
 * much that agent asks before it acts. Absent entirely until the member's
 * computers are known and the member may run turns there.
 */
export const ChatRunTargetMenu = ({
  activeOrganizationId,
  enabled,
  selected,
  onSelect,
}: ChatRunTargetMenuProps) => {
  const t = useTranslations();
  const stateLabel = useHarnessStateLabel();
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
  const readiness =
    runnersView.type === "items" ? runnersView.items : undefined;
  const options =
    chatLocalHarnessOptions(readiness) ??
    (selected.kind === "local" ? [] : null);
  if (options === null) {
    return null;
  }
  const value = runTargetValue(selected);
  const choose = (target: ChatRunTarget) => {
    if (!sameRunTarget(target, selected)) {
      onSelect(target);
    }
  };
  const maxApprovals = localRunMaxApprovals(readiness);
  const permissions = permissionView(selected, options, maxApprovals);

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
                  <TruncatedText render={<BidiText as="span" />}>
                    {name}
                  </TruncatedText>
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
                <TruncatedText render={<BidiText as="span" />}>
                  {name}
                </TruncatedText>
              </MenuSubTrigger>
              <MenuSubPopup className="w-64">
                <MenuRadioGroup value={value}>
                  {option.models.map((model) => {
                    const target = localRunTargetFor({
                      selected,
                      option,
                      model: model.id,
                      maxApprovals,
                    });
                    return (
                      <MenuRadioItem
                        key={model.id}
                        onClick={() => choose(target)}
                        value={runTargetValue(target)}
                      >
                        <TruncatedText render={<BidiText as="span" />}>
                          {model.label}
                        </TruncatedText>
                      </MenuRadioItem>
                    );
                  })}
                </MenuRadioGroup>
              </MenuSubPopup>
            </MenuSub>
          );
        })}
      </MenuRadioGroup>
      {permissions?.type === "fixed" && (
        <>
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel>{t("chat.localRun.permissions")}</MenuGroupLabel>
            <p className="text-muted-foreground text-2xs px-2 pb-1.5 text-pretty">
              {t(FIXED_PERMISSION_KEY[permissions.harness])}
            </p>
          </MenuGroup>
        </>
      )}
      {selected.kind === "local" && permissions?.type === "choice" && (
        <>
          <MenuSeparator />
          <MenuRadioGroup value={selected.approvals}>
            <MenuGroupLabel>{t("chat.localRun.permissions")}</MenuGroupLabel>
            {permissions.modes.map(({ mode, availability }) => (
              <MenuRadioItem
                disabled={availability !== "available"}
                key={mode}
                onClick={() => choose({ ...selected, approvals: mode })}
                value={mode}
              >
                <span className="flex min-w-0 flex-col py-0.5">
                  <span>{t(LOCAL_RUN_PERMISSION_KEYS[mode].label)}</span>
                  <span className="text-muted-foreground text-2xs text-pretty">
                    {availability === "available"
                      ? t(LOCAL_RUN_PERMISSION_KEYS[mode].description)
                      : t(UNAVAILABLE_PERMISSION_KEY[availability])}
                  </span>
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </>
      )}
      {selected.kind === "local" && (
        <>
          <MenuSeparator />
          <MenuRadioGroup value={runFolderValue(selected)}>
            <MenuGroupLabel>{t("chat.localRun.folder")}</MenuGroupLabel>
            <MenuRadioItem
              onClick={() => choose(withRunFolder(selected, undefined))}
              value={CHAT_OWN_FOLDER_VALUE}
            >
              {t("chat.localRun.folderOwn")}
            </MenuRadioItem>
            {chatLocalFolderOptions(readiness).map((option) => (
              <LinkedFolderItem
                key={`${option.folder.desktopId}:${option.folder.linkId}`}
                onChoose={() => choose(withRunFolder(selected, option.folder))}
                option={option}
              />
            ))}
            <p className="text-muted-foreground text-2xs px-2 pb-1.5 text-pretty">
              {t("chat.localRun.folderHint")}
            </p>
          </MenuRadioGroup>
        </>
      )}
      {/* stella's own models follow only while the turns run there. */}
      {selected.kind === "cloud" && <MenuSeparator />}
    </>
  );
};

/**
 * A folder linked on one of the member's computers, by its name only; one
 * that cannot take a turn now says why and cannot be chosen.
 */
const LinkedFolderItem = ({
  option,
  onChoose,
}: {
  option: ChatLocalFolderOption;
  onChoose: () => void;
}) => {
  const t = useTranslations();
  const { state } = option;
  return (
    <MenuRadioItem
      disabled={state !== DESKTOP_RUNNER_LINKED_FOLDER_STATE.available}
      onClick={onChoose}
      value={option.folder.linkId}
    >
      <span className="flex min-w-0 flex-col py-0.5">
        <TruncatedText render={<BidiText as="span" />}>
          {option.folder.name}
        </TruncatedText>
        {state === DESKTOP_RUNNER_LINKED_FOLDER_STATE.available ? null : (
          <span className="text-muted-foreground text-2xs">
            {t(FOLDER_PROBLEM_KEY[state])}
          </span>
        )}
      </span>
    </MenuRadioItem>
  );
};
