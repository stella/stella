import { useCallback, useEffect, useState } from "react";

import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";

import { authClient } from "@/lib/auth";

const OFFICE_JS_URL =
  "https://appsforoffice.microsoft.com/lib/1.1/hosted/office.js";
const MESSAGE_TYPE = "stella:auth";

type HandoffState =
  | { type: "loading" }
  | { type: "signed-out" }
  | { type: "signing-in" }
  | { type: "delivered" }
  | { message: string; type: "error" };

type DialogParent = {
  messageParent: (message: string) => void;
};

type OfficeRuntime = {
  context?: {
    ui?: DialogParent;
  };
  onReady: () => Promise<void>;
};

const isOfficeRuntime = (value: unknown): value is OfficeRuntime =>
  typeof value === "object" &&
  value !== null &&
  "onReady" in value &&
  typeof value.onReady === "function";

const getOffice = (): OfficeRuntime | null => {
  const value: unknown = Reflect.get(globalThis, "Office");
  return isOfficeRuntime(value) ? value : null;
};

const loadOfficeJs = async (): Promise<OfficeRuntime | null> => {
  const existing = getOffice();
  if (existing) {
    await existing.onReady();
    return existing;
  }

  return await new Promise<OfficeRuntime | null>((resolve) => {
    const script = document.createElement("script");
    script.src = OFFICE_JS_URL;
    script.async = true;
    script.addEventListener("load", () => {
      const office = getOffice();
      if (!office) {
        resolve(null);
        return;
      }
      void office.onReady().finally(() => resolve(office));
    });
    script.addEventListener("error", () => resolve(null));
    document.head.append(script);
  });
};

const SignInOutlook = () => {
  const t = useTranslations("outlook");
  const [state, setState] = useState<HandoffState>({ type: "loading" });

  const tryDeliverToken = useCallback(async () => {
    const office = await loadOfficeJs();

    const session = await authClient.getSession();
    const token = session.data?.session.token;
    if (!token) {
      setState({ type: "signed-out" });
      return;
    }

    const parent = office?.context?.ui;
    if (!parent) {
      setState({
        message: t("handoffMissingDialog"),
        type: "error",
      });
      return;
    }

    parent.messageParent(JSON.stringify({ token, type: MESSAGE_TYPE }));
    setState({ type: "delivered" });
  }, [t]);

  useEffect(() => {
    void tryDeliverToken();
  }, [tryDeliverToken]);

  const handleSignIn = async () => {
    setState({ type: "signing-in" });
    const callbackURL = new URL(
      "/sign-in-outlook",
      window.location.origin,
    ).toString();
    const { error } = await authClient.signIn.social({
      callbackURL,
      provider: "microsoft",
    });
    if (error) {
      setState({
        message: error.message ?? "Sign-in failed.",
        type: "error",
      });
    }
  };

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 p-6 text-center">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">{t("handoffTitle")}</h1>
        <p className="text-muted-foreground">{t("handoffDescription")}</p>
      </header>

      {state.type === "loading" && <p>{t("loading")}</p>}
      {state.type === "signing-in" && <p>{t("loading")}</p>}
      {state.type === "delivered" && (
        <p className="text-muted-foreground">{t("handoffSuccess")}</p>
      )}
      {state.type === "signed-out" && (
        <Button onClick={() => void handleSignIn()}>
          {t("handoffSignInCta")}
        </Button>
      )}
      {state.type === "error" && (
        <p className="text-destructive">{state.message}</p>
      )}
    </main>
  );
};

export const Route = createFileRoute("/sign-in-outlook")({
  component: SignInOutlook,
});
