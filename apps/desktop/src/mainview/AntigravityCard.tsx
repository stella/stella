import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { AntigravityLogoIcon } from "@stll/ui/brand-icons";
import { Button } from "@stll/ui/button";
import { ListItemMedia } from "@stll/ui/list";
import { SettingsRow } from "@stll/ui/settings";

import type {
  AntigravityStatus,
  AntigravityUncheckedReason,
} from "./antigravity-status";
import { SignedInLine } from "./SignedInLine";

/**
 * Where "Check again" is: `idle` until it is pressed, `checking` while the
 * CLI is asked, `checked` once it answered, so an answer that did not change
 * still says it was looked at.
 */
export type AntigravityCheck = "idle" | "checking" | "checked";

/**
 * The member-installed Antigravity CLI: its version and whether it is signed
 * in, as the CLI itself told the run probe. It signs in from its own
 * terminal command; it has no sign-in command stella could start.
 */
export const AntigravityCard = ({
  status,
  check,
  onCheckAgain,
}: {
  status: AntigravityStatus;
  check: AntigravityCheck;
  onCheckAgain: () => void;
}) => {
  const t = useTranslations("agentSubscriptions");
  const checking = check === "checking";
  return (
    <SettingsRow
      description={
        // Read out when a check ends, whatever it found.
        <span role="status">
          {checking ? (
            t("antigravity.checking")
          ) : (
            <AntigravityStatusLine
              checked={check === "checked"}
              status={status}
            />
          )}
        </span>
      }
      footer={
        status.state === "not_installed" ? null : (
          <p className="text-muted-foreground text-xs">
            {t("install.ready", {
              name: t("antigravity.title"),
              version: status.version,
            })}
          </p>
        )
      }
      media={
        <ListItemMedia>
          <AntigravityLogoIcon />
        </ListItemMedia>
      }
      title={t("antigravity.title")}
    >
      <Button loading={checking} onClick={onCheckAgain} variant="outline">
        {t("antigravity.checkAgain")}
      </Button>
    </SettingsRow>
  );
};

/** One line: signed in, or why not and what to do. */
const AntigravityStatusLine = ({
  status,
  checked,
}: {
  status: AntigravityStatus;
  /** A check the member asked for just ended. */
  checked: boolean;
}) => {
  const t = useTranslations("agentSubscriptions");
  switch (status.state) {
    case "signed_in":
      // The CLI does not tell stella its account.
      return <SignedInLine email={null} />;
    case "signed_out":
      return t(
        checked ? "antigravity.stillSignedOut" : "antigravity.signedOut",
      );
    case "unchecked":
      return t(UNCHECKED_MESSAGES[status.reason]);
    case "not_installed":
      return t("antigravity.notInstalled");
    case "too_old":
      return t("antigravity.tooOld");
    default:
      status satisfies never;
      return panic("Unknown Antigravity state");
  }
};

const UNCHECKED_MESSAGES = {
  not_connected: "antigravity.notConnected",
  check_failed: "antigravity.checkFailed",
} as const satisfies Record<
  AntigravityUncheckedReason,
  `antigravity.${string}`
>;
