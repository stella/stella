import { useState } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Input } from "@stll/ui/input";
import { Label } from "@stll/ui/label";

/**
 * Finishes a sign-in from the address the browser ended on, for when the
 * browser could not reach the app's local callback.
 */
export const ChatGptPasteCallback = ({
  onComplete,
}: {
  onComplete: (url: string) => Promise<boolean>;
}) => {
  const t = useTranslations("agentSubscriptions");
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitting(true);
        void onComplete(url).then((completed) => {
          setSubmitting(false);
          if (completed) {
            setUrl("");
          }
          return undefined;
        });
      }}
    >
      <Label
        className="text-muted-foreground block text-sm leading-relaxed font-normal"
        htmlFor="chatgpt-callback-url"
      >
        {t("pasteDescription")}
      </Label>
      <div className="flex items-center gap-2">
        <Input
          autoComplete="off"
          className="min-w-0 flex-1"
          id="chatgpt-callback-url"
          onChange={(event) => {
            setUrl(event.target.value);
          }}
          placeholder="http://127.0.0.1:…/auth/callback?…"
          spellCheck={false}
          value={url}
        />
        <Button
          disabled={submitting || url.trim() === ""}
          type="submit"
          variant="outline"
        >
          {t("pasteSubmit")}
        </Button>
      </div>
    </form>
  );
};
