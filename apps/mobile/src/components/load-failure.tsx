import { useTransition } from "react";

import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Button } from "@stll/ui/button";
import { Text } from "@stll/ui/text";

import { EmptyCard } from "@/components/empty-state-screen";
import { RetryButton } from "@/components/retry-button";
import { useSession } from "@/connection/session-provider";
import { needsConsent } from "@/state/api-request";
import type { ApiError } from "@/state/api-request";

/**
 * Why a screen's data did not load, as far as the app can tell: no answer
 * at all, an answer this build cannot read, a sign-in that needs renewing,
 * or the server's own failure or refusal.
 */
type LoadFailure =
  | { readonly kind: "offline" }
  | { readonly kind: "outdated" }
  | { readonly kind: "consent" }
  | { readonly kind: "session" }
  | { readonly kind: "server"; readonly status: number }
  | {
      readonly kind: "refused";
      readonly status: number;
      readonly detail: string | undefined;
    };

const loadFailure = (error: ApiError): LoadFailure => {
  if (error._tag === "SignedOutError") {
    return { kind: "session" };
  }
  if (error._tag === "TokenError") {
    // A refusal that ends the grant arrives as SignedOutError; any other,
    // such as temporarily_unavailable, may pass on a retry. Without a
    // status, the token endpoint never answered.
    if (error.status === undefined) {
      return { kind: "offline" };
    }
    return error.status >= 500
      ? { kind: "server", status: error.status }
      : { kind: "refused", status: error.status, detail: undefined };
  }
  if (needsConsent(error)) {
    return { kind: "consent" };
  }
  if (error.status === undefined) {
    // An answer that failed the schema is a server this build cannot read;
    // anything else without a status never reached one.
    return error.cause instanceof v.ValiError
      ? { kind: "outdated" }
      : { kind: "offline" };
  }
  if (error.status >= 500) {
    return { kind: "server", status: error.status };
  }
  return { kind: "refused", status: error.status, detail: error.detail };
};

/**
 * What a list shows when its data did not load: what failed, why, and the
 * way out, which is trying again or, for a sign-in that cannot read this,
 * signing in again.
 */
export const LoadFailedCard = ({
  error,
  onRetry,
  retryLabel,
  title,
}: {
  error: ApiError;
  onRetry: () => void;
  retryLabel: string;
  /** What did not load, such as "Your conversations could not be loaded." */
  title: string;
}) => {
  const t = useTranslations("loads");
  const writes = useTranslations("writes");
  const { signOut } = useSession();
  const [leaving, startLeaving] = useTransition();
  const failure = loadFailure(error);
  const reason =
    failure.kind === "server" || failure.kind === "refused"
      ? t(failure.kind, { status: String(failure.status) })
      : t(failure.kind);

  return (
    <EmptyCard description={reason} title={title}>
      {failure.kind === "refused" && failure.detail !== undefined ? (
        // The server's own words, which it writes in English.
        <Text className="max-w-90 text-center" variant="caption">
          {failure.detail}
        </Text>
      ) : null}
      {failure.kind === "consent" || failure.kind === "session" ? (
        <Button
          disabled={leaving}
          loading={leaving}
          onPress={() => {
            startLeaving(async () => {
              await signOut();
            });
          }}
          variant="outline"
        >
          {writes("signInAgain")}
        </Button>
      ) : (
        <RetryButton label={retryLabel} onPress={onRetry} />
      )}
    </EmptyCard>
  );
};
