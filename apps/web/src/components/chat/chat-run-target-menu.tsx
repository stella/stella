import { type ComponentType, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  CHAT_RUN_TARGET_KIND,
  type ChatLocalRunHarness,
  type ChatRunTarget,
  type DesktopSetUpHarness,
  isDesktopSetUpHarness,
} from "@stll/api-contract/chat-run-target";
import { desktopAgentSettingsUrl } from "@stll/api-contract/desktop-account-link";
import {
  DESKTOP_RUNNER_LINKED_FOLDER_STATE,
  type DesktopRunnerApprovalMode,
} from "@stll/api-contract/desktop-runner";
import { BidiText } from "@stll/ui/bidi-text";
import {
  ChevronRightIcon,
  ClipboardListIcon,
  CloudIcon,
  LaptopIcon,
  MessageCircleQuestionIcon,
  ShieldCheckIcon,
  ZapIcon,
} from "@stll/ui/icons";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from "@stll/ui/menu";
import { TruncatedText } from "@stll/ui/truncated-text";
import { cn } from "@stll/ui/utils";

import { LocalHarnessIcon } from "@/components/ai-provider-icons";
import {
  CHAT_LOCAL_HARNESS_NAMES,
  CHAT_OWN_FOLDER_VALUE,
  type ChatCloudStart,
  type ChatLocalFolderOption,
  chatLocalFolderOptions,
  type ChatLocalHarnessOption,
  chatLocalHarnessOptionsFor,
  CLOUD_PERMISSION_KEYS,
  cloudRunTargetWithin,
  defaultHarnessModel,
  LOCAL_RUN_PERMISSION_KEYS,
  type LocalRunFolderProblem,
  localRunMaxApprovals,
  localRunTargetFor,
  type LocalRunTargetState,
  type PermissionAvailability,
  type PermissionView,
  permissionView,
  runFolderValue,
  runOnPlaceValue,
  sameRunTarget,
  withRunFolder,
} from "@/components/chat/chat-run-target-menu.logic";
import { localRunnersOptions } from "@/features/chat/queries";
import { useDesktopLaunch } from "@/features/chat/use-desktop-launch";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { openDesktopUrl } from "@/lib/desktop-bridge";
import { detached } from "@/lib/detached";
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
  antigravity: "chat.localRun.permissionAskDescription",
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

/**
 * Why a new chat started in the cloud although the member last chose their
 * computer, as the where chip says it.
 */
export const useCloudStartLabel = () => {
  const t = useTranslations();
  const stateLabel = useLocalRunTargetStateLabel();
  return ({ harness, why }: ChatCloudStart): string => {
    switch (why.type) {
      case "unavailable":
        return t("chat.runOn.startedInCloud", {
          harness: CHAT_LOCAL_HARNESS_NAMES[harness],
          state: stateLabel(why.state) ?? t("chat.localRun.stateUnavailable"),
        });
      case "check_failed":
        return t("chat.runOn.startedInCloudCheckFailed");
      default:
        why satisfies never;
        return panic("Unknown cloud start");
    }
  };
};

/**
 * What a member does about a harness that cannot take a turn now, said in
 * its row of the where chip; a usage limit says when it lifts instead.
 */
const UNAVAILABLE_HINT_KEY = {
  needs_login: "chat.runOn.hintSignIn",
  not_installed: "chat.runOn.hintInstall",
  unsupported: "chat.runOn.hintUpdate",
  unavailable: "chat.runOn.hintCheck",
  offline: "chat.runOn.hintOffline",
} as const satisfies Record<UnavailableState, TranslationKey>;

/**
 * Agents the member installs and signs in to themselves, outside stella
 * desktop: what to do about one that cannot take a turn yet.
 */
const MEMBER_SETUP_HINT_KEY =
  "chat.runOn.hintAntigravity" satisfies TranslationKey;

export const useHarnessHint = () => {
  const t = useTranslations();
  const stateLabel = useHarnessStateLabel();
  return (option: ChatLocalHarnessOption): string | null => {
    const memberSetup = !isDesktopSetUpHarness(option.harness);
    switch (option.state) {
      case "ready":
        return null;
      case "limit_until":
        return stateLabel(option);
      case "needs_login":
      case "not_installed":
      case "unsupported":
      case "unavailable":
        return memberSetup
          ? t(MEMBER_SETUP_HINT_KEY)
          : t(UNAVAILABLE_HINT_KEY[option.state]);
      case "offline":
        return t(UNAVAILABLE_HINT_KEY[option.state]);
      default:
        option satisfies never;
        return panic("Unknown harness state");
    }
  };
};

/** A place and the line under it that says what choosing it means. */
const PlaceLabel = ({
  title,
  description,
}: {
  title: string;
  description: string;
}) => (
  <span className="flex min-w-0 flex-col py-0.5">
    <span>{title}</span>
    <span className="text-muted-foreground text-2xs text-pretty">
      {description}
    </span>
  </span>
);

const NO_HARNESS_OPTIONS: readonly ChatLocalHarnessOption[] = [];

/**
 * The member's computers could not be read: nothing is claimed about them,
 * and the member can read them again.
 */
export const ReadinessRetry = ({
  retry,
}: {
  retry: () => Promise<unknown>;
}) => {
  const t = useTranslations();
  return (
    <>
      <p className="text-muted-foreground text-2xs px-2 pb-1.5 text-pretty">
        {t("chat.runOn.checkFailed")}
      </p>
      <MenuItem
        onClick={() => {
          detached(retry(), "chat-run-on.retry-readiness");
        }}
      >
        {t("common.retry")}
      </MenuItem>
    </>
  );
};

/**
 * An agent on a computer that is not connected. Choosing it opens stella
 * desktop on this click and says so until a computer connects; the agent
 * is then offered in its place. A launch that times out leaves the row as
 * it was. The menu stays open meanwhile.
 */
const OfflineHarnessItem = ({
  activeOrganizationId,
  harness,
  name,
  hint,
}: {
  activeOrganizationId: string;
  harness: ChatLocalRunHarness;
  name: string;
  hint: string;
}) => {
  const t = useTranslations();
  const desktop = useDesktopLaunch(activeOrganizationId);
  const opening = desktop.state.type === "opening";
  return (
    <MenuItem
      closeOnClick={false}
      disabled={opening}
      onClick={() => {
        detached(desktop.launch(), "chat-run-on.open-desktop");
      }}
    >
      {/* PlaceLabel's layout; the description is a status region that
          stays mounted, so the change to the opening message is announced. */}
      <span className="flex min-w-0 items-start gap-2 py-0.5">
        <LocalHarnessIcon
          className="mt-0.5 size-4 shrink-0"
          harness={harness}
        />
        <span className="flex min-w-0 flex-col">
          <span>{name}</span>
          <span
            className="text-muted-foreground text-2xs text-pretty"
            role="status"
          >
            {opening ? t("settings.account.desktopCardOpeningTitle") : hint}
          </span>
        </span>
      </span>
    </MenuItem>
  );
};

/** A harness the member sets up at its card in stella desktop's Settings. */
type DesktopSetupOption = {
  harness: DesktopSetUpHarness;
  state: Exclude<UnavailableState, "offline">;
};

/** Each harness's sign-in, named by its button in stella desktop. */
const SIGN_IN_STEPS_KEY = {
  codex: "chat.runOn.stepsSignInCodex",
  "claude-code": "chat.runOn.stepsSignInClaudeCode",
} as const satisfies Record<DesktopSetUpHarness, TranslationKey>;

/**
 * The way to the harness's card by hand, said once the link to it was
 * handed over: stella desktop may not be on this computer, or may be one
 * too old to know the link, and nothing tells this page which.
 */
const useDesktopSetupSteps = () => {
  const t = useTranslations();
  return (option: DesktopSetupOption): string => {
    const harness = CHAT_LOCAL_HARNESS_NAMES[option.harness];
    switch (option.state) {
      case "needs_login":
        return t(SIGN_IN_STEPS_KEY[option.harness]);
      case "not_installed":
        return t("chat.runOn.stepsInstall", { harness });
      case "unsupported":
      case "unavailable":
        return t("chat.runOn.stepsCheck", { harness });
      default:
        option.state satisfies never;
        return panic("Unknown harness setup state");
    }
  };
};

/**
 * An agent its computer reports but cannot run yet: signed out, not
 * installed, a version it cannot use, or not available. Choosing it opens
 * stella desktop's Settings at the agent's card, where a signed-out agent's
 * sign-in starts; the row then says how to get there by hand. The menu
 * stays open meanwhile.
 */
const DesktopSetupHarnessItem = ({
  option,
  name,
  hint,
}: {
  option: DesktopSetupOption;
  name: string;
  hint: string;
}) => {
  const steps = useDesktopSetupSteps();
  const [opened, setOpened] = useState(false);
  return (
    <MenuItem
      closeOnClick={false}
      onClick={() => {
        openDesktopUrl(desktopAgentSettingsUrl(option.harness));
        setOpened(true);
      }}
    >
      {/* PlaceLabel's layout; the description is a status region that
          stays mounted, so the change to the steps is announced. */}
      <span className="flex min-w-0 items-start gap-2 py-0.5">
        <LocalHarnessIcon
          className="mt-0.5 size-4 shrink-0"
          harness={option.harness}
        />
        <span className="flex min-w-0 flex-col">
          <span>{name}</span>
          <span
            className="text-muted-foreground text-2xs text-pretty"
            role="status"
          >
            {opened ? steps(option) : hint}
          </span>
        </span>
      </span>
    </MenuItem>
  );
};

type ChatRunTargetMenuProps = {
  activeOrganizationId: string;
  /** Reads the member's computers only while the menu is open. */
  enabled: boolean;
  selected: ChatRunTarget;
  onSelect: (target: ChatRunTarget) => void;
  /** Why a new chat started in the cloud, said first; `null` otherwise. */
  startedInCloud: ChatCloudStart | null;
};

/**
 * The where chip's menu: the cloud or the member's computer, side by side;
 * on the computer, how much the agent may do before it asks, then each
 * coding agent on it and whether it can take a turn (a ready one is picked
 * with its recommended model; one that is not says what to do), and the
 * folder its turns work in. The model is the model chip's.
 */
export const ChatRunTargetMenu = ({
  activeOrganizationId,
  enabled,
  selected,
  onSelect,
  startedInCloud,
}: ChatRunTargetMenuProps) => {
  const t = useTranslations();
  const hint = useHarnessHint();
  const cloudStartLabel = useCloudStartLabel();
  const runnersView = queryView(
    useQuery({
      ...localRunnersOptions(activeOrganizationId),
      enabled,
    }),
  );
  const readiness =
    runnersView.type === "items" ? runnersView.items : undefined;
  // Until the member's computers are read, no agent is listed; a member who
  // may not run turns on a computer sees only the way back to the cloud.
  // With a linked folder chosen, the agents listed are the folder's
  // computer's, which its turns run on.
  const listed = chatLocalHarnessOptionsFor(readiness, selected);
  const options = listed ?? NO_HARNESS_OPTIONS;
  const choose = (target: ChatRunTarget) => {
    if (!sameRunTarget(target, selected)) {
      onSelect(target);
    }
  };
  const maxApprovals = localRunMaxApprovals(readiness);
  const permissions = permissionView(selected, options, maxApprovals);
  const permissionKeys =
    selected.kind === CHAT_RUN_TARGET_KIND.cloud
      ? CLOUD_PERMISSION_KEYS
      : LOCAL_RUN_PERMISSION_KEYS;
  const onComputer = selected.kind === CHAT_RUN_TARGET_KIND.local;
  // Moving to the computer picks its first ready agent on its recommended
  // model and keeps the menu open, so the member can change the agent, the
  // folder or the permissions next. With no agent ready, the agents' rows
  // below say what to set up.
  const showComputer = () => {
    if (onComputer) {
      return;
    }
    const ready = options.find(
      (option): option is ReadyHarnessOption => option.state === "ready",
    );
    if (ready !== undefined) {
      choose(
        localRunTargetFor({
          selected,
          option: ready,
          model: defaultHarnessModel(ready).id,
          maxApprovals,
        }),
      );
    }
  };

  return (
    <>
      {startedInCloud !== null && (
        <>
          <p className="text-muted-foreground px-2 py-1.5 text-xs text-pretty">
            {cloudStartLabel(startedInCloud)}
          </p>
          <MenuSeparator />
        </>
      )}
      <MenuRadioGroup
        value={
          onComputer ? CHAT_RUN_TARGET_KIND.local : CHAT_RUN_TARGET_KIND.cloud
        }
      >
        {/* The label names its group, so it lives inside it. */}
        <MenuGroupLabel>{t("chat.runOn.where")}</MenuGroupLabel>
        <div className={cn(SEGMENTS_CLASS_NAME, "grid-cols-2")}>
          <MenuRadioItem
            appearance="segment"
            closeOnClick
            onClick={() =>
              choose(cloudRunTargetWithin(selected.approvals, maxApprovals))
            }
            value={CHAT_RUN_TARGET_KIND.cloud}
          >
            <CloudIcon aria-hidden="true" />
            {t("chat.runOn.cloud")}
          </MenuRadioItem>
          <MenuRadioItem
            appearance="segment"
            closeOnClick={false}
            onClick={showComputer}
            value={CHAT_RUN_TARGET_KIND.local}
          >
            <LaptopIcon aria-hidden="true" />
            {t("chat.runOn.yourComputer")}
          </MenuRadioItem>
        </div>
        <p className="text-muted-foreground text-2xs px-2 pt-1.5 pb-1 text-pretty">
          {onComputer
            ? t("chat.runOn.yourComputerDescription")
            : t("chat.runOn.cloudDescription")}
        </p>
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
      {permissions?.type === "choice" && (
        <PermissionChoice
          hint={
            selected.kind === CHAT_RUN_TARGET_KIND.cloud
              ? t("chat.runOn.cloudPermissionsHint")
              : null
          }
          keys={permissionKeys}
          modes={permissions.modes}
          onChoose={(mode) => choose({ ...selected, approvals: mode })}
          selected={selected.approvals}
        />
      )}
      {(options.length > 0 || runnersView.type === "error") && (
        <>
          <MenuSeparator />
          <MenuRadioGroup value={runOnPlaceValue(selected)}>
            <MenuGroupLabel>{t("chat.runOn.agent")}</MenuGroupLabel>
            {runnersView.type === "error" && (
              <ReadinessRetry retry={runnersView.retry} />
            )}
            {options.map((option) => {
              const name = CHAT_LOCAL_HARNESS_NAMES[option.harness];
              if (option.state === "offline") {
                return (
                  <OfflineHarnessItem
                    activeOrganizationId={activeOrganizationId}
                    harness={option.harness}
                    hint={hint(option) ?? ""}
                    key={option.harness}
                    name={name}
                  />
                );
              }
              if (option.state === "limit_until") {
                return (
                  <MenuItem disabled key={option.harness}>
                    <PlaceLabel description={hint(option) ?? ""} title={name} />
                  </MenuItem>
                );
              }
              if (option.state !== "ready") {
                const { harness } = option;
                if (!isDesktopSetUpHarness(harness)) {
                  // Set up outside stella desktop: there is nothing to open.
                  return (
                    <MenuItem disabled key={harness}>
                      <span className="flex min-w-0 items-start gap-2">
                        <LocalHarnessIcon
                          className="mt-1 size-4 shrink-0"
                          harness={harness}
                        />
                        <PlaceLabel
                          description={hint(option) ?? ""}
                          title={name}
                        />
                      </span>
                    </MenuItem>
                  );
                }
                return (
                  <DesktopSetupHarnessItem
                    hint={hint(option) ?? ""}
                    key={option.harness}
                    name={name}
                    option={{ harness, state: option.state }}
                  />
                );
              }
              // The agent keeps the chat's model when it is the one chosen.
              const target =
                selected.kind === "local" && selected.harness === option.harness
                  ? selected
                  : localRunTargetFor({
                      selected,
                      option,
                      model: defaultHarnessModel(option).id,
                      maxApprovals,
                    });
              return (
                <MenuRadioItem
                  closeOnClick
                  key={option.harness}
                  onClick={() => choose(target)}
                  value={runOnPlaceValue(target)}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <LocalHarnessIcon
                      className="size-4 shrink-0"
                      harness={option.harness}
                    />
                    <TruncatedText render={<BidiText as="span" />}>
                      {name}
                    </TruncatedText>
                  </span>
                </MenuRadioItem>
              );
            })}
          </MenuRadioGroup>
        </>
      )}
      {selected.kind === "local" && (
        <>
          <MenuSeparator />
          <MenuRadioGroup value={runFolderValue(selected)}>
            <MenuGroupLabel>{t("common.folder")}</MenuGroupLabel>
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
    </>
  );
};

type ReadyHarnessOption = Extract<ChatLocalHarnessOption, { state: "ready" }>;

/** A row of choices laid out as one segmented control. */
const SEGMENTS_CLASS_NAME = "bg-muted mx-2 grid gap-1 rounded-md p-1";

/** Each permission mode's mark in the row, from the most cautious. */
const PERMISSION_ICON = {
  plan: ClipboardListIcon,
  ask: MessageCircleQuestionIcon,
  auto: ShieldCheckIcon,
  full_auto: ZapIcon,
} as const satisfies Record<
  DesktopRunnerApprovalMode,
  ComponentType<{ className?: string }>
>;

/**
 * How much the agent may do before it asks: the modes in one row from the
 * most cautious to the most independent, with the chosen mode's name and
 * what it lets the agent do under the row. A mode that cannot be chosen says
 * why in its name and once under the row. A pick keeps the menu open.
 */
const PermissionChoice = ({
  hint,
  keys,
  modes,
  selected,
  onChoose,
}: {
  /** What the levels decide, said under the group's label; `null` for none. */
  hint: string | null;
  keys: typeof LOCAL_RUN_PERMISSION_KEYS | typeof CLOUD_PERMISSION_KEYS;
  modes: Extract<PermissionView, { type: "choice" }>["modes"];
  selected: DesktopRunnerApprovalMode;
  onChoose: (mode: DesktopRunnerApprovalMode) => void;
}) => {
  const t = useTranslations();
  const named = modes.map(({ mode, availability }) => {
    const label = t(keys[mode].label);
    return {
      mode,
      available: availability === "available",
      name:
        availability === "available"
          ? label
          : t("chat.localRun.selectionStateLabel", {
              selection: label,
              state: t(UNAVAILABLE_PERMISSION_KEY[availability]),
            }),
    };
  });
  return (
    <>
      <MenuSeparator />
      <MenuRadioGroup value={selected}>
        <MenuGroupLabel>{t("chat.localRun.permissions")}</MenuGroupLabel>
        {hint !== null && (
          <p className="text-muted-foreground text-2xs px-2 pb-1.5 text-pretty">
            {hint}
          </p>
        )}
        <div className={cn(SEGMENTS_CLASS_NAME, "grid-cols-4")}>
          {named.map(({ mode, available, name }) => {
            const Icon = PERMISSION_ICON[mode];
            return (
              <MenuRadioItem
                aria-label={name}
                appearance="segment"
                closeOnClick={false}
                disabled={!available}
                key={mode}
                onClick={() => onChoose(mode)}
                value={mode}
              >
                <Icon aria-hidden="true" />
              </MenuRadioItem>
            );
          })}
        </div>
        {/* The row's order, from asking most to asking least. */}
        <div
          aria-hidden="true"
          className="text-muted-foreground text-2xs flex items-center gap-2 px-3 pt-1"
        >
          <span>{t("chat.localRun.permissionScaleLow")}</span>
          <span className="flex flex-1 items-center">
            <span className="bg-border h-px flex-1" />
            <ChevronRightIcon className="text-border -ms-1.5 size-3 rtl:rotate-180" />
          </span>
          <span>{t("chat.localRun.permissionScaleHigh")}</span>
        </div>
        <p className="flex flex-col px-2 pt-1.5 pb-1">
          <span>{t(keys[selected].label)}</span>
          <span className="text-muted-foreground text-2xs text-pretty">
            {t(keys[selected].description)}
          </span>
        </p>
        {named
          .filter(({ available }) => !available)
          .map(({ mode, name }) => (
            <p
              className="text-muted-foreground text-2xs px-2 pb-1 text-pretty"
              key={mode}
            >
              {name}
            </p>
          ))}
      </MenuRadioGroup>
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
