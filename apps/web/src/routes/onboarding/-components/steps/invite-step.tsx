import { useCallback, useRef, useState } from "react";

import { AlertTriangleIcon, XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { Input } from "@stella/ui/components/input";
import { cn } from "@stella/ui/lib/utils";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DELIMITERS = /[,;\n\t]/;

const getDomain = (email: string) => email.split("@")[1]?.toLowerCase() ?? "";

type InviteStepProps = {
  userEmail: string;
  onNext: (data: { emails: string[] }) => void;
  onEmailCountChange?: (count: number) => void;
};

export const InviteStep = ({
  userEmail,
  onNext,
  onEmailCountChange,
}: InviteStepProps) => {
  const userDomain = getDomain(userEmail);
  const t = useTranslations();
  const [emails, setEmails] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const processInput = useCallback(
    (raw: string) => {
      const tokens = raw
        .split(DELIMITERS)
        .map((s) => s.trim())
        .filter(Boolean);

      const valid: string[] = [];
      const invalid: string[] = [];

      for (const token of tokens) {
        const lower = token.toLowerCase();
        if (EMAIL_REGEX.test(lower)) {
          if (!emails.includes(lower) && !valid.includes(lower)) {
            valid.push(lower);
          }
        } else {
          invalid.push(token);
        }
      }

      if (valid.length > 0) {
        setEmails((prev) => {
          const next = [...prev, ...valid];
          onEmailCountChange?.(next.length);
          return next;
        });
      }

      if (invalid.length > 0) {
        setError(
          t("onboarding.inviteInvalidEmail", {
            value: invalid.join(", "),
          }),
        );
        setInput(invalid.join(", "));
        // Flash the input
        const el = inputRef.current;
        if (el) {
          el.classList.add("ring-2", "ring-destructive");
          setTimeout(() => {
            el.classList.remove("ring-2", "ring-destructive");
          }, 600);
        }
      } else {
        setError("");
        setInput("");
      }
    },
    [emails, t, onEmailCountChange],
  );

  const removeEmail = (email: string) => {
    setEmails((prev) => {
      const next = prev.filter((e) => e !== email);
      onEmailCountChange?.(next.length);
      return next;
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === "Tab" || e.key === ",") {
      e.preventDefault();
      if (input.trim()) {
        processInput(input);
      }
    }
    if (e.key === "Backspace" && input === "" && emails.length > 0) {
      setEmails((prev) => {
        const next = prev.slice(0, -1);
        onEmailCountChange?.(next.length);
        return next;
      });
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    processInput(e.clipboardData.getData("text"));
  };

  return (
    <>
      <h1 className="text-foreground text-3xl font-light tracking-tight">
        {t("onboarding.inviteTitle")}
      </h1>
      <p className="text-muted-foreground mt-2 text-sm">
        {t("onboarding.inviteSubtitle")}
      </p>

      <div className="mt-8 flex flex-col gap-3">
        {/* Email chips */}
        {emails.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {emails.map((email) => {
              const isExternal =
                userDomain.length > 0 && getDomain(email) !== userDomain;
              return (
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm",
                    isExternal
                      ? "bg-warning/10 text-warning-foreground border-warning/20 border"
                      : "bg-accent text-foreground",
                  )}
                  key={email}
                >
                  {isExternal && (
                    <AlertTriangleIcon className="size-3 shrink-0 text-amber-500" />
                  )}
                  {email}
                  <button
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => removeEmail(email)}
                    type="button"
                  >
                    <XIcon className="size-3" />
                  </button>
                </span>
              );
            })}
            {userDomain.length > 0 &&
              emails.some((e) => getDomain(e) !== userDomain) && (
                <p className="text-xs text-amber-500">
                  <AlertTriangleIcon className="mr-1 inline size-3" />
                  {t("onboarding.inviteExternal")}
                </p>
              )}
          </div>
        )}

        <Input
          autoFocus
          onChange={(e) => {
            setInput(e.target.value);
            if (error) {
              setError("");
            }
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="colleague@example.com"
          ref={inputRef}
          value={input}
        />
        {error ? (
          <p className="text-destructive text-xs">{error}</p>
        ) : (
          <p className="text-muted-foreground/50 text-xs">
            {t("onboarding.inviteHint")}
          </p>
        )}
      </div>

      <div className="mt-8 flex items-center justify-end gap-3">
        <Button
          onClick={() => onNext({ emails: [] })}
          type="button"
          variant="ghost"
        >
          {t("onboarding.skipStep")}
        </Button>
        <Button
          onClick={() => {
            let finalEmails = emails;
            if (input.trim()) {
              const tokens = input
                .split(/[,;\n\t]/)
                .map((s) => s.trim())
                .filter(Boolean);
              const valid = tokens
                .map((s) => s.toLowerCase())
                .filter((s) => EMAIL_REGEX.test(s));
              const hasInvalid = valid.length < tokens.length;
              processInput(input);
              if (hasInvalid) {
                return;
              }
              // Compute final list synchronously since
              // setEmails is async and won't update yet
              const deduped = valid.filter((s) => !emails.includes(s));
              finalEmails = [...emails, ...deduped];
            }
            onNext({ emails: finalEmails });
          }}
          type="button"
        >
          {t("onboarding.getStarted")}
        </Button>
      </div>
    </>
  );
};
