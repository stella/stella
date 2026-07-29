import { useState } from "react";

import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";

import { useMountEffect } from "@/hooks/use-effect";
import { authClient } from "@/lib/auth";

const OFFICE_JS_URL =
  "https://appsforoffice.microsoft.com/lib/1.1/hosted/office.js";
const MESSAGE_TYPE = "stella:auth";
const ALLOWED_PARENT_ORIGINS = new Set([
  "https://outlook.stll.app",
  "https://localhost:3002",
]);

type HandoffState =
  | { type: "loading" }
  | { type: "signed-out" }
  | { type: "signing-in" }
  | { type: "delivered" }
  | { message: string; type: "error" };

type DialogParent = {
  messageParent: (message: string, options: { targetOrigin: string }) => void;
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
  const t = useTranslations("auth");
  const tCommon = useTranslations("common");
  const [state, setState] = useState<HandoffState>({ type: "loading" });

  useMountEffect(() => {
    const tryDeliverToken = async () => {
      const parentOrigin = new URLSearchParams(window.location.search).get(
        "parentOrigin",
      );
      if (!parentOrigin || !ALLOWED_PARENT_ORIGINS.has(parentOrigin)) {
        setState({
          message: t("outlookHandoffMissingDialog"),
          type: "error",
        });
        return;
      }

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
          message: t("outlookHandoffMissingDialog"),
          type: "error",
        });
        return;
      }

      parent.messageParent(JSON.stringify({ token, type: MESSAGE_TYPE }), {
        targetOrigin: parentOrigin,
      });
      setState({ type: "delivered" });
    };

    void tryDeliverToken();
  });

  const handleSignIn = async () => {
    setState({ type: "signing-in" });
    const callbackURL = new URL(window.location.href);
    callbackURL.hash = "";
    const { error } = await authClient.signIn.social({
      callbackURL: callbackURL.toString(),
      provider: "microsoft",
    });
    if (error) {
      setState({
        message: t("error.generic"),
        type: "error",
      });
    }
  };

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 p-6 text-center">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">{t("outlookHandoffTitle")}</h1>
        <p className="text-muted-foreground">
          {t("outlookHandoffDescription")}
        </p>
      </header>

      {state.type === "loading" && <p>{tCommon("loading")}</p>}
      {state.type === "signing-in" && <p>{tCommon("loading")}</p>}
      {state.type === "delivered" && (
        <p className="text-muted-foreground">{t("outlookHandoffSuccess")}</p>
      )}
      {state.type === "signed-out" && (
        <Button onClick={() => void handleSignIn()}>{t("signIn")}</Button>
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
