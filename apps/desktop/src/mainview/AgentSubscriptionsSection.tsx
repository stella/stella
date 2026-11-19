import { useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { panic, Result } from "better-result";

import { Separator } from "@stll/ui/separator";

import { subscribeDesktopEvent } from "../shared/desktop-events";
import {
  CHATGPT_AUTH_CHANGED_EVENT,
  chatGptCommandError,
  chatGptLinkSignIn,
  isChatGptStatus,
} from "./chatgpt-status";
import type { ChatGptSignIn, ChatGptStatus } from "./chatgpt-status";
import { ChatGptCard } from "./ChatGptCard";
import type { ChatGptNotice } from "./ChatGptCard";
import {
  CLAUDE_CODE_AUTH_CHANGED_EVENT,
  claudeCodeLinkStartsSignIn,
  isClaudeCodeStatus,
} from "./claude-code-status";
import type { ClaudeCodeStatus } from "./claude-code-status";
import { ClaudeCodeCard } from "./ClaudeCodeCard";
import {
  HARNESS_INSTALL_CHANGED_EVENT,
  harnessInstallState,
  isHarnessStatusList,
} from "./harness-install-status";
import type { HarnessStatus, ManagedHarness } from "./harness-install-status";
import { HarnessInstallLine } from "./HarnessInstallLine";

/** The coding agents' group, or one agent's card. */
export type AgentSettingsFocus = "agents" | ManagedHarness;

/** How long a card brought into view stays marked, and the mark. */
const FOCUS_HIGHLIGHT_MS = 2000;
const HIGHLIGHT_ATTRIBUTE = "data-highlighted";

/**
 * AI subscriptions the local agents can use. It renders nothing unless the
 * local agents feature is on: the status commands refuse otherwise. A
 * requested `focus` (from a `stella://settings/agents` link) is scrolled to
 * and marked briefly once its card shows, the agent's sign-in starts when it
 * needs one, and `onFocusShown` clears the request.
 */
export const AgentSubscriptionsSection = ({
  focus,
  onFocusShown,
  renderGroup,
}: {
  focus: AgentSettingsFocus | null;
  onFocusShown: () => void;
  renderGroup: (content: React.JSX.Element) => React.JSX.Element;
}) => {
  const [chatGpt, refreshChatGpt] = useNativeStatus<ChatGptStatus>({
    read: readChatGptStatus,
    event: CHATGPT_AUTH_CHANGED_EVENT,
    isStatus: isChatGptStatus,
  });
  const [claudeCode, refreshClaudeCode] = useNativeStatus<ClaudeCodeStatus>({
    read: readClaudeCodeStatus,
    event: CLAUDE_CODE_AUTH_CHANGED_EVENT,
    isStatus: isClaudeCodeStatus,
  });
  const [harnesses, refreshHarnesses] = useNativeStatus<
    readonly HarnessStatus[]
  >({
    read: readHarnessStatus,
    event: HARNESS_INSTALL_CHANGED_EVENT,
    isStatus: isHarnessStatusList,
  });
  const [notice, setNotice] = useState<ChatGptNotice | null>(null);
  const [claudeCodeFailed, setClaudeCodeFailed] = useState(false);
  // Set before a start command is sent, so a second click in the same
  // frame cannot send another.
  const starting = useRef(false);
  const startingClaudeCode = useRef(false);
  const run = async (command: () => Promise<unknown>) => {
    setNotice(null);
    const result = await Result.tryPromise(command);
    if (Result.isError(result)) {
      setNotice("actionFailed");
      return null;
    }
    return result.value;
  };

  const runClaudeCode = async (command: () => Promise<unknown>) => {
    setClaudeCodeFailed(false);
    const result = await Result.tryPromise(command);
    if (Result.isError(result)) {
      setClaudeCodeFailed(true);
      return null;
    }
    return result.value;
  };

  const signInChatGpt = ({ account, newAccount }: ChatGptSignIn) => {
    if (starting.current) {
      return;
    }
    starting.current = true;
    void run(async () =>
      invoke<unknown>("chatgpt_auth_start", {
        account: account ?? null,
        newAccount,
      }),
    ).then(() => {
      starting.current = false;
      // Shown at once, without waiting for the change event.
      refreshChatGpt();
      return undefined;
    });
  };

  const signInClaudeCode = () => {
    if (startingClaudeCode.current) {
      return;
    }
    startingClaudeCode.current = true;
    void runClaudeCode(async () =>
      invoke<unknown>("claude_code_auth_start"),
    ).then(() => {
      startingClaudeCode.current = false;
      // Shown at once, without waiting for the change event.
      refreshClaudeCode();
      return undefined;
    });
  };

  /**
   * A link naming an agent starts that agent's sign-in once its card is in
   * view, through the card's own start, unless it is signed in or a sign-in
   * already runs. A link to the whole group starts nothing.
   */
  const startSignInFor = (shownFocus: AgentSettingsFocus) => {
    switch (shownFocus) {
      case "agents":
        return;
      case "codex": {
        const request = chatGpt === null ? null : chatGptLinkSignIn(chatGpt);
        if (request !== null) {
          signInChatGpt(request);
        }
        return;
      }
      case "claude-code":
        if (claudeCode !== null && claudeCodeLinkStartsSignIn(claudeCode)) {
          signInClaudeCode();
        }
        return;
      default:
        shownFocus satisfies never;
        panic("Unknown agent settings focus");
    }
  };

  useFocusRequest({
    focus,
    onShown: (shownFocus) => {
      startSignInFor(shownFocus);
      onFocusShown();
    },
    shown: {
      agents: chatGpt !== null || claudeCode !== null,
      codex: chatGpt !== null,
      "claude-code": claudeCode !== null,
    },
  });

  if (chatGpt === null && claudeCode === null) {
    return null;
  }

  /** A card that a link can scroll to and mark. */
  const focusTarget = (
    target: AgentSettingsFocus,
    content: React.JSX.Element,
  ) => (
    <div
      className="data-highlighted:bg-muted outline-none"
      data-agent-settings={target}
      tabIndex={-1}
    >
      {content}
    </div>
  );

  /** The CLI's install line; a refused command shows the card's notice. */
  const installLine = (
    harness: ManagedHarness,
    name: string,
    onFailed: () => void,
  ) => {
    const state = harnessInstallState(harnesses, harness);
    if (state === null) {
      return null;
    }
    const send = (command: () => Promise<unknown>) => {
      void Result.tryPromise(command).then((result) => {
        if (Result.isError(result)) {
          onFailed();
        }
        // Shown at once, without waiting for the change event.
        refreshHarnesses();
        return undefined;
      });
    };
    return (
      <HarnessInstallLine
        name={name}
        onCancel={(operationId) => {
          send(async () =>
            invoke("harness_cancel_install", { harness, operationId }),
          );
        }}
        onInstall={() => {
          send(async () => invoke("harness_install", { harness }));
        }}
        state={state}
      />
    );
  };

  const chatGptCard =
    chatGpt === null ? null : (
      <ChatGptCard
        install={installLine("codex", "Codex", () => {
          setNotice("actionFailed");
        })}
        notice={notice}
        onCancel={() => {
          void run(async () => invoke("chatgpt_auth_cancel"));
        }}
        onComplete={async (url) => {
          const result = await Result.tryPromise(async () =>
            invoke("chatgpt_auth_complete", { url }),
          );
          if (Result.isOk(result)) {
            setNotice(null);
            return true;
          }
          setNotice(
            chatGptCommandError(result.error) === "not_this_sign_in"
              ? "pasteRejected"
              : "actionFailed",
          );
          return false;
        }}
        onDisconnect={() => {
          void run(async () => invoke<unknown>("chatgpt_auth_disconnect")).then(
            (value) => {
              if (
                typeof value === "object" &&
                value !== null &&
                "revocationConfirmed" in value &&
                value.revocationConfirmed === false
              ) {
                setNotice("revocationUnconfirmed");
              }
              return undefined;
            },
          );
        }}
        onManageUsage={() => {
          void run(async () => invoke("chatgpt_auth_open_usage"));
        }}
        onSignIn={signInChatGpt}
        status={chatGpt}
      />
    );

  const claudeCodeCard =
    claudeCode === null ? null : (
      <ClaudeCodeCard
        actionFailed={claudeCodeFailed}
        install={installLine("claude-code", "Claude Code", () => {
          setClaudeCodeFailed(true);
        })}
        onCancel={() => {
          void runClaudeCode(async () => invoke("claude_code_auth_cancel"));
        }}
        onOpenSignInPage={() => {
          void runClaudeCode(async () =>
            invoke("claude_code_auth_open_sign_in_page"),
          );
        }}
        onSignIn={signInClaudeCode}
        onSignOut={() => {
          void runClaudeCode(async () => invoke("claude_code_auth_sign_out"));
        }}
        onCheckAgain={refreshClaudeCode}
        status={claudeCode}
      />
    );

  return renderGroup(
    focusTarget(
      "agents",
      <>
        {chatGptCard ? focusTarget("codex", chatGptCard) : null}
        {chatGptCard && claudeCodeCard ? <Separator /> : null}
        {claudeCodeCard ? focusTarget("claude-code", claudeCodeCard) : null}
      </>,
    ),
  );
};

/**
 * Scrolls to the requested card once it shows, moves focus there for a
 * keyboard or screen reader, marks it for a moment and then reports the
 * request shown, once per request, so showing General again later does not
 * repeat it. The mark
 * is a data attribute on the card's own element, which outlives the request.
 */
const useFocusRequest = ({
  focus,
  onShown,
  shown,
}: {
  focus: AgentSettingsFocus | null;
  onShown: (focus: AgentSettingsFocus) => void;
  shown: Record<AgentSettingsFocus, boolean>;
}) => {
  const ready = focus !== null && shown[focus];
  useEffect(() => {
    if (focus === null || !ready) {
      return;
    }
    const target = document.querySelector<HTMLElement>(
      `[data-agent-settings="${focus}"]`,
    );
    if (target === null) {
      return;
    }
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    target.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "center",
    });
    target.focus({ preventScroll: true });
    target.toggleAttribute(HIGHLIGHT_ATTRIBUTE, true);
    window.setTimeout(() => {
      target.toggleAttribute(HIGHLIGHT_ATTRIBUTE, false);
    }, FOCUS_HIGHLIGHT_MS);
    onShown(focus);
  }, [focus, ready, onShown]);
};

const readChatGptStatus = async () =>
  invoke<unknown>("chatgpt_auth_get_status");
const readClaudeCodeStatus = async () =>
  invoke<unknown>("claude_code_auth_get_status");
const readHarnessStatus = async () => invoke<unknown>("harness_get_status");

/**
 * A native status, read when its change event is live, again on every
 * change and whenever `refresh` is called. `null` while unread, refused
 * (the local agents feature is off) or malformed.
 */
export const useNativeStatus = <T,>({
  read,
  event,
  isStatus,
}: {
  read: () => Promise<unknown>;
  event: string;
  isStatus: (value: unknown) => value is T;
}) => {
  const [status, setStatus] = useState<T | null>(null);
  // The mounted effect's ordered read; a no-op outside it.
  const refreshLive = useRef<() => void>(() => undefined);
  useEffect(() => {
    let disposed = false;
    let latest = 0;
    const refresh = async () => {
      latest += 1;
      const current = latest;
      const result = await Result.tryPromise(read);
      if (disposed || current !== latest) {
        return;
      }
      setStatus(
        Result.isOk(result) && isStatus(result.value) ? result.value : null,
      );
    };
    refreshLive.current = () => {
      void refresh();
    };
    const stop = subscribeDesktopEvent<unknown>({
      event,
      handler: () => {
        void refresh();
      },
      onError: () => {
        setStatus(null);
      },
      onSubscribed: () => {
        void refresh();
      },
    });
    return () => {
      disposed = true;
      refreshLive.current = () => undefined;
      stop();
    };
  }, [read, event, isStatus]);
  // Reads again in order with the change events, so an older answer never
  // replaces a newer one.
  const refresh = () => {
    refreshLive.current();
  };
  return [status, refresh] as const;
};
