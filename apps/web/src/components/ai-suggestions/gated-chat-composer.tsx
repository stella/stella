/**
 * What a reader without an account gets where the composer floats over a
 * document: a sign-in offer in the composer's place, not a bar that looks
 * typeable and cannot send. It carries no runtime, so nothing anonymous ever
 * reaches an AI endpoint, and it names the document so the offer says what
 * the account is for.
 */

// The offer floats over the document exactly as the live bar does, so the
// same integration stylesheet has to come with it: without it the reader
// reserves no trailing space and its last paragraphs sit under the offer. The
// live overlay imports it from its own module, and this chunk is the only
// other place a composer is mounted.
import "@/components/ai-suggestions/file-viewer-with-ai.css";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { CircleUserRoundIcon } from "@stll/ui/icons";

import { useFileChatPlaceholder } from "@/components/ai-suggestions/file-chat-placeholder";
import type { FileChatPlaceholderSource } from "@/components/ai-suggestions/file-chat-placeholder";
import { useRequireAccount } from "@/components/auth/use-require-account";
import {
  DockedComposer,
  PromptBarShell,
} from "@/components/chat/docked-composer";

export const GatedChatComposer = (props: FileChatPlaceholderSource) => {
  const t = useTranslations();
  const ensureAccount = useRequireAccount();
  const { sourceLabel } = useFileChatPlaceholder(props);

  return (
    <DockedComposer
      bar={
        <PromptBarShell
          className="items-center gap-2 ps-3 pe-1.5"
          data-slot="gated-chat-sign-in"
        >
          <span className="text-foreground-muted min-w-0 flex-1 truncate text-sm">
            {sourceLabel === undefined ? (
              t("chat.signInToChat")
            ) : (
              <>
                {t("chat.signInToChatAbout")}{" "}
                <BidiText as="span" className="text-foreground-label">
                  {sourceLabel}
                </BidiText>
              </>
            )}
          </span>
          <Button
            className="shrink-0"
            onClick={() => {
              ensureAccount();
            }}
            size="sm"
          >
            <CircleUserRoundIcon aria-hidden="true" className="size-3.5" />
            {t("auth.signIn")}
          </Button>
        </PromptBarShell>
      }
    />
  );
};
