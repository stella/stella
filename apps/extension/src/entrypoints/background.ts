import { panic } from "better-result";
import { defineBackground } from "wxt/utils/define-background";

import {
  BROWSER_CONTROL_ACTION,
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_EXTENSION_MESSAGE_SOURCE,
  type BrowserControlErrorCode,
  type BrowserControlResult,
  type BrowserExtensionRequest,
  type BrowserExtensionResponse,
  parseBrowserExtensionRequest,
} from "@stll/api-contract/browser-control";

import {
  hasAllSiteAccess,
  hasDesktopLinkAccess,
  removeAllSiteAccess,
} from "../lib/access";
import { browserControlError } from "../lib/browser-control-result";
import { storedCommandBudget } from "../lib/command-budget";
import {
  admitControl,
  CONTROL_ADMISSION,
  CONTROL_TRANSPORT,
  takeOverControl,
} from "../lib/control-owner";
import { createControlSession } from "../lib/control-session";
import {
  controllerForSender,
  disconnectBrowserController,
  endControllerAfterTabClosed,
  notifyStellaTabs,
  pairStellaTab,
  readBrowserController,
} from "../lib/controller";
import {
  createDesktopLink,
  DESKTOP_LINK_ALARM,
  type DesktopCommand,
  desktopControllerId,
  realDesktopLinkTimer,
} from "../lib/desktop-link";
import {
  enforceStoppedDownload,
  holdDownloadForJudgement,
  judgeDownload,
  loadDownloadScope,
  noteNavigation,
  setDownloadScope,
  takeDownloadNotices,
} from "../lib/download-guard";
import { executeAtMostOnce } from "../lib/execution-ledger";
import {
  forgetOpenedTab,
  judgeOpenedTab,
  sortCommittedNavigation,
  sortNavigationTarget,
} from "../lib/opened-tabs";
import {
  isExtensionPageSender,
  parsePopupRequest,
  POPUP_PORT_NAME,
  type PopupResponse,
} from "../lib/popup-request";
import { SIGN_IN_POLICY, type SignInPolicy } from "../lib/sign-in-policy";
import {
  forgetStellaTab,
  rememberStellaTab,
  replaceStellaTab,
} from "../lib/stella-tabs";
import {
  forgetContainedTab,
  onContainedTabsChanged,
  replaceTab,
} from "../lib/tab-containment";
import {
  adoptControlledTab,
  executeBrowserCommand,
  forgetControlledTab,
  readControlledTabId,
  replaceControlledTab,
} from "../lib/tab-executor";
import { trustedStellaOriginFromUrl } from "../lib/trusted-origin";

/**
 * Every web command, cancel, popup change and tab loss goes through this
 * one session, so a disconnect can never race a command it should stop.
 */
const session = createControlSession();

const isTrustedSender = (sender: chrome.runtime.MessageSender): boolean => {
  if (sender.id !== chrome.runtime.id || !sender.url) {
    return false;
  }
  return trustedStellaOriginFromUrl(sender.url) !== null;
};

/** Tells the connected stella tabs about a change to the controlled tab. */
const notifyController = async (): Promise<void> => {
  const controller = await readBrowserController();
  if (controller) {
    await notifyStellaTabs(controller.origin, {
      controlledTabId: await readControlledTabId(controller.controllerId),
      controllerId: controller.controllerId,
    });
  }
};

/**
 * Chrome swapped one tab for another (a prerendered page taking over): every
 * record of the old tab id moves to the new one, in turn with commands.
 */
const handleTabReplaced = async (
  addedTabId: number,
  removedTabId: number,
): Promise<void> => {
  await session.change(async () => {
    await replaceTab(addedTabId, removedTabId);
    await replaceStellaTab(addedTabId, removedTabId);
    const controlledMoved = await replaceControlledTab(
      addedTabId,
      removedTabId,
    );
    if (controlledMoved) {
      await notifyController();
    }
  });
};

const handleTabRemoved = async (tabId: number): Promise<void> => {
  forgetOpenedTab(tabId);
  const closedStellaTab = await forgetStellaTab(tabId);
  if (closedStellaTab !== null) {
    // Checked inside the session, so a pairing queued ahead is applied.
    await session.change(async () => {
      await endControllerAfterTabClosed(closedStellaTab);
    });
    return;
  }
  const controller = await readBrowserController();
  if (
    controller !== null &&
    (await readControlledTabId(controller.controllerId)) === tabId
  ) {
    await session.change(async () => {
      if (await forgetControlledTab(tabId)) {
        await notifyController();
      }
    });
    return;
  }
  await forgetContainedTab(tabId);
};

/**
 * `onDeterminingFilename` as Chrome documents it: a listener that answers
 * later returns true, and Chrome then waits for its `suggest`. The bundled
 * types declare a void listener.
 */
type FilenameEvents = {
  addListener: (
    listener: (
      download: chrome.downloads.DownloadItem,
      suggest: () => void,
    ) => boolean,
  ) => void;
};

const filenameEvents = (): FilenameEvents =>
  chrome.downloads.onDeterminingFilename;

let downloadGuardRegistered = false;
let navigationTargetsRegistered = false;

/**
 * `downloads` and `webNavigation` are optional and granted with website
 * access, so their listeners attach at startup when already granted and on
 * the grant otherwise.
 */
const registerOptionalListeners = (): void => {
  if (!downloadGuardRegistered && Reflect.has(chrome, "downloads")) {
    downloadGuardRegistered = true;
    // Chrome writes no file until the name is suggested, so a download is
    // judged first; the created event covers downloads whose name something
    // else chose.
    filenameEvents().addListener(holdDownloadForJudgement);
    chrome.downloads.onCreated.addListener((download) => {
      judgeDownload(download).catch(() => undefined);
    });
    chrome.downloads.onChanged.addListener((delta) => {
      enforceStoppedDownload(delta).catch(() => undefined);
    });
  }
  if (!navigationTargetsRegistered && Reflect.has(chrome, "webNavigation")) {
    navigationTargetsRegistered = true;
    chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
      sortNavigationTarget(details).catch(() => undefined);
    });
    chrome.webNavigation.onCommitted.addListener((details) => {
      sortCommittedNavigation(details).catch(() => undefined);
    });
    // A download a navigation turns into is traced to the tab that made it.
    chrome.webNavigation.onBeforeNavigate.addListener((details) => {
      noteNavigation(details).catch(() => undefined);
    });
  }
};

type CommandRequest = Extract<BrowserExtensionRequest, { type: "command" }>;

type ControlledCommand = Pick<
  CommandRequest,
  "command" | "controllerId" | "observedTab" | "toolCallId" | "turnId"
> & {
  /**
   * Checked inside the session, once changes queued ahead of the command
   * have been applied: refuses the command, or admits it, with the takeover
   * an `open` runs once nothing refused it.
   */
  admit: () => Promise<Admission>;
  signIn: SignInPolicy;
};

type Admission =
  | { type: "refused"; result: BrowserControlResult }
  | { type: "admitted"; takeOver: (() => Promise<void>) | null };

const ADMITTED = { takeOver: null, type: "admitted" } as const;

const refused = (
  code: BrowserControlErrorCode,
  message: string,
): Admission => ({
  result: browserControlError(code, message),
  type: "refused",
});

/** One command from either transport, through the one control session. */
const runControlledCommand = async ({
  admit,
  command,
  controllerId,
  observedTab,
  signIn,
  toolCallId,
  turnId,
}: ControlledCommand): Promise<BrowserControlResult> => {
  const execution = await session.runCommand(
    { controllerId, turnId },
    async (signal) => {
      const admission = await admit();
      switch (admission.type) {
        case "refused":
          return admission.result;
        case "admitted":
          break;
        default:
          admission satisfies never;
          return panic("Unhandled command admission");
      }
      if (!(await hasAllSiteAccess())) {
        return browserControlError(
          BROWSER_CONTROL_ERROR_CODE.permissionDenied,
          "Grant stella access to websites from the extension popup.",
        );
      }
      return await executeAtMostOnce({
        command,
        controllerId,
        execute: async () =>
          await executeBrowserCommand(controllerId, command, {
            budget: storedCommandBudget({ command, controllerId, turnId }),
            observedTab,
            signal,
            signIn,
            takeOver: admission.takeOver,
          }),
        toolCallId,
      });
    },
  );
  return execution.status === "completed"
    ? execution.result
    : browserControlError(
        BROWSER_CONTROL_ERROR_CODE.controllerBusy,
        "Another approved browser action is still running. Wait for it to finish, then retry.",
      );
};

const runCommand = async (
  message: CommandRequest,
  senderUrl: string,
): Promise<BrowserControlResult> =>
  await runControlledCommand({
    admit: async () => {
      const controller = await controllerForSender(senderUrl);
      if (controller?.controllerId !== message.controllerId) {
        return refused(
          BROWSER_CONTROL_ERROR_CODE.staleController,
          "Connect stella from the extension popup before using browser actions.",
        );
      }
      // While a desktop chat holds the browser, this connection lists,
      // switches to and acts on nothing.
      const admission = await admitControl({
        action: message.command.action,
        controllerId: controller.controllerId,
        transport: CONTROL_TRANSPORT.web,
      });
      return admission === CONTROL_ADMISSION.holds
        ? ADMITTED
        : refused(
            BROWSER_CONTROL_ERROR_CODE.staleController,
            "stella desktop is using the browser now. Connect stella again from the extension popup to take it back.",
          );
    },
    command: message.command,
    controllerId: message.controllerId,
    observedTab: message.observedTab,
    signIn: SIGN_IN_POLICY.withholdSecrets,
    toolCallId: message.toolCallId,
    turnId: message.turnId,
  });

/**
 * What a coding agent on this computer may ask for: its tools open, read,
 * click and type. Switching to another chat's tab, going back, keys and
 * selects are refused.
 */
const DESKTOP_ACTIONS: ReadonlySet<string> = new Set([
  BROWSER_CONTROL_ACTION.click,
  BROWSER_CONTROL_ACTION.fill,
  BROWSER_CONTROL_ACTION.open,
  BROWSER_CONTROL_ACTION.snapshot,
]);

/**
 * A command from a coding agent on this computer. Chrome only starts the
 * host for this extension and the member allowed it, so there is no pairing
 * to check. A desktop chat that does not hold the browser may only open a
 * page, which takes the browser over once nothing refused it: the previous
 * holder loses its controlled tab and its tabs go back to the member.
 */
const runDesktopCommand = async (
  message: DesktopCommand,
): Promise<BrowserControlResult> => {
  const controllerId = desktopControllerId(message.controllerId);
  const { command } = message;
  if (!DESKTOP_ACTIONS.has(command.action)) {
    return browserControlError(
      BROWSER_CONTROL_ERROR_CODE.invalidCommand,
      "stella desktop opens, reads, clicks and types only.",
    );
  }
  const result = await runControlledCommand({
    admit: async () => {
      const admission = await admitControl({
        action: command.action,
        controllerId,
        transport: CONTROL_TRANSPORT.desktop,
      });
      switch (admission) {
        case CONTROL_ADMISSION.holds:
          return ADMITTED;
        case CONTROL_ADMISSION.takesOver:
          return {
            takeOver: async () => {
              await takeOverControl({
                controllerId,
                transport: CONTROL_TRANSPORT.desktop,
              });
            },
            type: "admitted",
          };
        case CONTROL_ADMISSION.refused:
          return refused(
            BROWSER_CONTROL_ERROR_CODE.noControlledTab,
            "Another chat is using the browser. Open a page to take it over.",
          );
        default:
          admission satisfies never;
          return panic("Unhandled control admission");
      }
    },
    command,
    controllerId,
    observedTab: message.observedTab,
    signIn: SIGN_IN_POLICY.handToMember,
    toolCallId: message.toolCallId,
    turnId: message.turnId,
  });
  // A web chat that had the tab hears it no longer does.
  await notifyController();
  return result;
};

const desktopLink = createDesktopLink({
  cancel: ({ controllerId, turnId }) => {
    session.stopTurn({
      controllerId: desktopControllerId(controllerId),
      turnId,
    })();
  },
  runCommand: runDesktopCommand,
  timer: realDesktopLinkTimer,
});

const handleWebMessage = (
  rawMessage: unknown,
  sender: chrome.runtime.MessageSender,
): void => {
  const message = parseBrowserExtensionRequest(rawMessage);
  const senderTabId = sender.tab?.id;
  if (!message || !isTrustedSender(sender) || senderTabId === undefined) {
    return;
  }
  const senderUrl = sender.url ?? "";
  const senderOrigin = trustedStellaOriginFromUrl(senderUrl);
  if (senderOrigin !== null) {
    rememberStellaTab(senderTabId, {
      documentId: sender.documentId ?? null,
      origin: senderOrigin,
    }).catch(() => undefined);
  }

  if (message.type === "cancel") {
    // The target is fixed on receipt; checking the sender reads storage,
    // and a command admitted meanwhile is not the one being stopped.
    const stop = session.stopTurn({
      controllerId: message.controllerId,
      turnId: message.turnId,
    });
    controllerForSender(senderUrl)
      .then((controller) => {
        if (controller?.controllerId === message.controllerId) {
          stop();
        }
        return undefined;
      })
      .catch(() => undefined);
    return;
  }

  // Admitted synchronously, before any await, so a cancel the page sends
  // right after this command always finds it.
  const result =
    message.type === "command" ? runCommand(message, senderUrl) : null;

  const respond = async (): Promise<BrowserExtensionResponse> => {
    if (result === null) {
      const controller = await controllerForSender(senderUrl);
      return {
        allSitesGranted: await hasAllSiteAccess(),
        controlledTabId: controller
          ? await readControlledTabId(controller.controllerId)
          : null,
        controllerId: controller?.controllerId ?? null,
        protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
        requestId: message.requestId,
        source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
        type: "pong",
      };
    }
    return {
      protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
      requestId: message.requestId,
      result: await result,
      source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
      type: "command-result",
    };
  };
  respond()
    .catch((): BrowserExtensionResponse => ({
      protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
      requestId: message.requestId,
      result: {
        code: BROWSER_CONTROL_ERROR_CODE.executionFailed,
        message: "The browser extension could not process this request.",
        protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
        status: "error",
      },
      source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
      type: "command-result",
    }))
    .then(async (response) => {
      await chrome.tabs.sendMessage(senderTabId, response);
      return undefined;
    })
    .catch(() => undefined);
};

const handlePopupRequest = async (
  rawMessage: unknown,
): Promise<PopupResponse> => {
  const request = parsePopupRequest(rawMessage);
  if (!request) {
    return { status: "failed" };
  }
  switch (request.type) {
    case "pair":
      return await session.change<PopupResponse>(async () => {
        const paired = await pairStellaTab(request.tabId);
        return paired.status === "paired"
          ? { status: "done" }
          : { status: "unsupported-tab" };
      });
    case "adopt":
      return await session.change<PopupResponse>(async () => {
        const controller = await readBrowserController();
        const tab = await chrome.tabs.get(request.tabId).catch(() => null);
        if (controller === null || tab === null) {
          return { status: "unsupported-tab" };
        }
        // Handing a tab over takes the browser back from a desktop chat.
        const { controllerId } = controller;
        const adopted = await adoptControlledTab(
          controllerId,
          tab,
          (await admitControl({
            action: BROWSER_CONTROL_ACTION.snapshot,
            controllerId,
            transport: CONTROL_TRANSPORT.web,
          })) === CONTROL_ADMISSION.holds
            ? null
            : async () => {
                await takeOverControl({ transport: CONTROL_TRANSPORT.web });
              },
        );
        if (adopted.status === "unsupported-page") {
          return { status: "unsupported-page" };
        }
        await notifyController();
        return { status: "adopted", url: adopted.url };
      });
    case "disconnect":
      return await session.change<PopupResponse>(async () => {
        await disconnectBrowserController();
        return { status: "done" };
      });
    case "revoke":
      return await session.change<PopupResponse>(async () => {
        await removeAllSiteAccess();
        await disconnectBrowserController();
        return { status: "done" };
      });
    case "take-download-notices":
      return { ...(await takeDownloadNotices()), status: "download-notices" };
    default:
      request satisfies never;
      return panic("Unhandled popup request");
  }
};

export default defineBackground(() => {
  onContainedTabsChanged(setDownloadScope);
  loadDownloadScope().catch(() => undefined);
  registerOptionalListeners();
  chrome.permissions.onAdded.addListener(registerOptionalListeners);
  // Every worker start reconnects: Chrome ends the host with the worker.
  desktopLink.connect().catch(() => undefined);
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === DESKTOP_LINK_ALARM) {
      desktopLink.connect().catch(() => undefined);
    }
  });
  chrome.permissions.onAdded.addListener(() => {
    desktopLink.connect().catch(() => undefined);
  });
  chrome.permissions.onRemoved.addListener(() => {
    // A desktop command already running stops and answers on the
    // still-open link before it closes. Access is read once that work has
    // settled: granted again meanwhile, the open link stays.
    session
      .change(async () => {
        if (!(await hasDesktopLinkAccess())) {
          await desktopLink.disconnect();
        }
      })
      .catch(() => undefined);
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    handleTabRemoved(tabId).catch(() => undefined);
  });
  chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    handleTabReplaced(addedTabId, removedTabId).catch(() => undefined);
  });
  chrome.tabs.onUpdated.addListener((_tabId, _change, tab) => {
    judgeOpenedTab(tab).catch(() => undefined);
  });

  chrome.runtime.onMessage.addListener((rawMessage, sender) => {
    handleWebMessage(rawMessage, sender);
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== POPUP_PORT_NAME || !isExtensionPageSender(port.sender)) {
      port.disconnect();
      return;
    }
    port.onMessage.addListener((rawMessage: unknown) => {
      handlePopupRequest(rawMessage)
        .catch((): PopupResponse => ({ status: "failed" }))
        .then((response) => {
          port.postMessage(response);
          return undefined;
        })
        .catch(() => undefined);
    });
  });
});
