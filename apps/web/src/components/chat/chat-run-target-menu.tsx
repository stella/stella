import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  CHAT_CLOUD_RUN_TARGET,
  CHAT_RUN_TARGET_KIND,
  type ChatLocalRunHarness,
  type ChatLocalRunTarget,
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
} from "@stll/ui/menu";
import { TruncatedText } from "@stll/ui/truncated-text";

import { EFFORT_LABEL_KEY } from "@/components/chat/chat-model-options-menu.logic";
import {
  CHAT_LOCAL_HARNESS_NAMES,
  CHAT_OWN_FOLDER_VALUE,
  type ChatLocalFolderOption,
  chatLocalFolderOptions,
  type ChatLocalHarnessOption,
  chatLocalHarnessOptionsFor,
  defaultHarnessModel,
  LOCAL_RUN_PERMISSION_KEYS,
  type LocalRunFolderProblem,
  localRunMaxApprovals,
  localRunTargetFor,
  type LocalRunTargetState,
  type PermissionAvailability,
  permissionView,
  reasoningEffortChoices,
  runFolderValue,
  runOnPlaceValue,
  sameRunTarget,
  withRunFolder,
} from "@/components/chat/chat-run-target-menu.logic";
import { localRunnersOptions } from "@/features/chat/queries";
import { useDesktopLaunch } from "@/features/chat/use-desktop-launch";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
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

/** The radio value of leaving the reasoning effort to the harness. */
const HARNESS_DEFAULT_EFFORT = "harness-default";

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

/**
 * What a member does about a harness that cannot take a turn now, said in
 * its row of the where chip; a usage limit says when it lifts instead.
 */
const UNAVAILABLE_HINT_KEY = {
  needs_login: "chat.runOn.hintSignIn",
  not_installed: "chat.runOn.hintInstall",
  unsupported: "chat.runOn.hintUpdate",
  unavailable: "chat.localRun.stateUnavailable",
  offline: "chat.runOn.hintOffline",
} as const satisfies Record<UnavailableState, TranslationKey>;

const useHarnessHint = () => {
  const t = useTranslations();
  const stateLabel = useHarnessStateLabel();
  return (option: ChatLocalHarnessOption): string | null => {
    switch (option.state) {
      case "ready":
        return null;
      case "limit_until":
        return stateLabel(option);
      case "needs_login":
      case "not_installed":
      case "unsupported":
      case "unavailable":
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
const ReadinessRetry = ({ retry }: { retry: () => Promise<unknown> }) => {
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
  name,
  hint,
}: {
  activeOrganizationId: string;
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
      <span className="flex min-w-0 flex-col py-0.5">
        <span>{name}</span>
        <span
          className="text-muted-foreground text-2xs text-pretty"
          role="status"
        >
          {opening ? t("settings.account.desktopCardOpeningTitle") : hint}
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
};

/**
 * The where chip's menu: the cloud, or the member's computer with each
 * coding agent on it and whether it can take a turn (a ready one is picked
 * with its recommended model; one that is not says what to do), the folder
 * its turns work in, and then how much that agent may do before it asks.
 * The model is the model chip's.
 */
export const ChatRunTargetMenu = ({
  activeOrganizationId,
  enabled,
  selected,
  onSelect,
}: ChatRunTargetMenuProps) => {
  const t = useTranslations();
  const hint = useHarnessHint();
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

  return (
    <>
      <MenuRadioGroup value={runOnPlaceValue(selected)}>
        {/* Picking a place or an agent is the choice the menu exists for,
            so it closes; a permission pick keeps it open for another. */}
        <MenuRadioItem
          closeOnClick
          onClick={() => choose(CHAT_CLOUD_RUN_TARGET)}
          value={CHAT_RUN_TARGET_KIND.cloud}
        >
          <PlaceLabel
            description={t("chat.runOn.cloudDescription")}
            title={t("chat.runOn.cloud")}
          />
        </MenuRadioItem>
        <MenuSeparator />
        {/* The label names its group, so it lives inside it. */}
        <MenuGroupLabel>{t("chat.runOn.yourComputer")}</MenuGroupLabel>
        <p className="text-muted-foreground text-2xs px-2 pb-1.5 text-pretty">
          {t("chat.runOn.yourComputerDescription")}
        </p>
        {runnersView.type === "error" && (
          <ReadinessRetry retry={runnersView.retry} />
        )}
        {options.map((option) => {
          const name = CHAT_LOCAL_HARNESS_NAMES[option.harness];
          if (option.state === "offline") {
            return (
              <OfflineHarnessItem
                activeOrganizationId={activeOrganizationId}
                hint={hint(option) ?? ""}
                key={option.harness}
                name={name}
              />
            );
          }
          if (option.state !== "ready") {
            return (
              <MenuItem disabled key={option.harness}>
                <PlaceLabel description={hint(option) ?? ""} title={name} />
              </MenuItem>
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
              <TruncatedText render={<BidiText as="span" />}>
                {name}
              </TruncatedText>
            </MenuRadioItem>
          );
        })}
      </MenuRadioGroup>
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
                <PlaceLabel
                  description={
                    availability === "available"
                      ? t(LOCAL_RUN_PERMISSION_KEYS[mode].description)
                      : t(UNAVAILABLE_PERMISSION_KEY[availability])
                  }
                  title={t(LOCAL_RUN_PERMISSION_KEYS[mode].label)}
                />
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </>
      )}
    </>
  );
};

type LocalModelOptionsProps = {
  activeOrganizationId: string;
  enabled: boolean;
  selected: ChatLocalRunTarget;
  onSelect: (target: ChatRunTarget) => void;
};

/**
 * The model chip's menu for a chat on the member's computer: the agent's
 * recommended model first, then the rest by the names the agent gives them,
 * then the reasoning efforts the chosen model offers. A model the agent no
 * longer offers stays listed, marked so, until another is picked.
 */
export const LocalModelOptions = ({
  activeOrganizationId,
  enabled,
  selected,
  onSelect,
}: LocalModelOptionsProps) => {
  const t = useTranslations();
  const hint = useHarnessHint();
  const runnersView = queryView(
    useQuery({
      ...localRunnersOptions(activeOrganizationId),
      enabled,
    }),
  );
  const readiness =
    runnersView.type === "items" ? runnersView.items : undefined;
  const harness = CHAT_LOCAL_HARNESS_NAMES[selected.harness];
  if (runnersView.type === "error") {
    return <ReadinessRetry retry={runnersView.retry} />;
  }
  if (runnersView.type === "pending") {
    return (
      <p className="text-muted-foreground px-2.5 py-2 text-xs">
        {t("common.loading")}
      </p>
    );
  }
  // A turn in a linked folder runs on the folder's computer: its models are
  // that computer's.
  const options = chatLocalHarnessOptionsFor(readiness, selected);
  const option = options?.find(
    (candidate) => candidate.harness === selected.harness,
  );
  if (option?.state !== "ready") {
    return (
      <p className="text-muted-foreground px-2.5 py-2 text-xs text-pretty">
        {option === undefined
          ? t("chat.localRun.stateUnavailable")
          : hint(option)}
      </p>
    );
  }
  // An agent that marks no default (an older desktop) gets its models in
  // its own order, none called recommended.
  const recommended =
    option.models.find(({ isDefault }) => isDefault === true) ?? null;
  const others = option.models.filter(({ id }) => id !== recommended?.id);
  const offered = option.models.some(({ id }) => id === selected.model);
  const choose = (model: string) => {
    if (model !== selected.model) {
      onSelect(
        localRunTargetFor({
          selected,
          option,
          model,
          maxApprovals: localRunMaxApprovals(readiness),
        }),
      );
    }
  };
  const efforts = reasoningEffortChoices(
    selected,
    options ?? NO_HARNESS_OPTIONS,
  );
  const chooseEffort = (target: ChatLocalRunTarget) => {
    if (!sameRunTarget(target, selected)) {
      onSelect(target);
    }
  };
  return (
    <>
      <MenuRadioGroup value={selected.model}>
        <MenuGroupLabel>
          {t("chat.runOn.harnessModels", { harness })}
        </MenuGroupLabel>
        {recommended !== null && (
          <MenuRadioItem
            closeOnClick
            onClick={() => choose(recommended.id)}
            value={recommended.id}
          >
            <PlaceLabel
              description={recommended.label}
              title={t("chat.runOn.modelDefault")}
            />
          </MenuRadioItem>
        )}
        {others.map((model) => (
          <MenuRadioItem
            closeOnClick
            key={model.id}
            onClick={() => choose(model.id)}
            value={model.id}
          >
            <TruncatedText render={<BidiText as="span" />}>
              {model.label}
            </TruncatedText>
          </MenuRadioItem>
        ))}
        {!offered && (
          <MenuRadioItem disabled value={selected.model}>
            <PlaceLabel
              description={t("chat.localRun.stateModelUnavailable")}
              title={selected.model}
            />
          </MenuRadioItem>
        )}
      </MenuRadioGroup>
      {efforts !== null && (
        <>
          <MenuSeparator />
          <MenuRadioGroup
            value={selected.reasoningEffort ?? HARNESS_DEFAULT_EFFORT}
          >
            <MenuGroupLabel>
              {t("chat.modelSelector.effortLabel")}
            </MenuGroupLabel>
            <MenuRadioItem
              onClick={() =>
                chooseEffort({ ...selected, reasoningEffort: null })
              }
              value={HARNESS_DEFAULT_EFFORT}
            >
              {t("chat.modelSelector.effortValues.providerDefault")}
            </MenuRadioItem>
            {efforts.map((effort) => (
              <MenuRadioItem
                key={effort}
                onClick={() =>
                  chooseEffort({ ...selected, reasoningEffort: effort })
                }
                value={effort}
              >
                {t(EFFORT_LABEL_KEY[effort])}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </>
      )}
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
