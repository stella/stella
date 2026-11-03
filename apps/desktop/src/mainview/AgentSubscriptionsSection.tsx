import { useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { Result } from "better-result";

import { subscribeDesktopEvent } from "../shared/desktop-events";
import {
  CHATGPT_AUTH_CHANGED_EVENT,
  chatGptCommandError,
  isChatGptStatus,
} from "./chatgpt-status";
import type { ChatGptStatus } from "./chatgpt-status";
import { ChatGptCard } from "./ChatGptCard";
import type { ChatGptNotice } from "./ChatGptCard";

/**
 * AI subscriptions the local agents can use. It renders nothing unless the
 * local agents feature is on: the status command refuses otherwise.
 */
export const AgentSubscriptionsSection = ({
  renderGroup,
}: {
  renderGroup: (content: React.JSX.Element) => React.JSX.Element;
}) => {
  const [status, setStatus] = useState<ChatGptStatus | null>(null);
  const [notice, setNotice] = useState<ChatGptNotice | null>(null);
  // Set before the start command is sent, so a second click in the same
  // frame cannot send another.
  const starting = useRef(false);

  useEffect(() => {
    let disposed = false;
    let latest = 0;
    const refresh = async () => {
      latest += 1;
      const read = latest;
      const result = await Result.tryPromise(async () =>
        invoke<unknown>("chatgpt_auth_get_status"),
      );
      if (disposed || read !== latest) {
        return;
      }
      setStatus(
        Result.isOk(result) && isChatGptStatus(result.value)
          ? result.value
          : null,
      );
    };
    const stop = subscribeDesktopEvent<unknown>({
      event: CHATGPT_AUTH_CHANGED_EVENT,
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
      stop();
    };
  }, []);

  if (status === null) {
    return null;
  }

  const run = async (command: () => Promise<unknown>) => {
    setNotice(null);
    const result = await Result.tryPromise(command);
    if (Result.isError(result)) {
      setNotice("actionFailed");
      return null;
    }
    return result.value;
  };

  return renderGroup(
    <ChatGptCard
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
      onSignIn={({ account, newAccount }) => {
        if (starting.current) {
          return;
        }
        starting.current = true;
        void run(async () =>
          invoke<unknown>("chatgpt_auth_start", {
            account: account ?? null,
            newAccount,
          }),
        ).then((started) => {
          starting.current = false;
          // Shown at once, without waiting for the change event.
          if (isChatGptStatus(started)) {
            setStatus(started);
          }
          return undefined;
        });
      }}
      status={status}
    />,
  );
};
