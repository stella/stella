import { useState } from "react";
import { createRoot } from "react-dom/client";

import { DirectionProvider } from "@base-ui/react/direction-provider";
import { panic } from "better-result";

import {
  Dialog,
  DialogClose,
  DialogCreateHandle,
  DialogFormState,
  DialogPopup,
  DialogProvider,
  DialogTitle,
  DialogTrigger,
} from "../dialog";
import { Form } from "../form";
import { Input } from "../input";

const OpeningValue = "Stored question";
const DialogFixture = () => {
  const [handle] = useState(() => DialogCreateHandle<{ label: string }>());
  const [value, setValue] = useState(OpeningValue);
  const [locale, setLocale] = useState<"en" | "ar">("en");
  const [registration, setRegistration] = useState<"form" | "custom">("form");
  const [controlled, setControlled] = useState(false);
  const [veto, setVeto] = useState(false);
  const [showCloseButton, setShowCloseButton] = useState(true);
  const [open, setOpen] = useState(false);
  const dirty = value !== OpeningValue;
  const discard = () => setValue(OpeningValue);
  return (
    <main dir={locale === "ar" ? "rtl" : "ltr"}>
      <style>{`[data-slot=dialog-backdrop] { position: fixed; inset: 0; z-index: 85; }
      [data-slot=dialog-viewport] { position: fixed; inset: 0; display: grid; place-items: center; z-index: 85; pointer-events: none; }
      [data-slot=dialog-popup] { position: relative; pointer-events: auto; background: white; border: 1px solid; padding: 3rem 1rem 1rem; }
      [role=status] { margin-inline-end: 1rem; }`}</style>
      <button
        onClick={() => {
          const next = locale === "en" ? "ar" : "en";
          document.documentElement.dir = next === "ar" ? "rtl" : "ltr";
          setLocale(next);
        }}
        type="button"
      >
        Switch language
      </button>
      <label>
        <input
          checked={registration === "custom"}
          onChange={(event) =>
            setRegistration(event.target.checked ? "custom" : "form")
          }
          type="checkbox"
        />
        Custom form
      </label>
      <label>
        <input
          checked={controlled}
          onChange={(event) => setControlled(event.target.checked)}
          type="checkbox"
        />
        Controlled
      </label>
      <DirectionProvider direction={locale === "ar" ? "rtl" : "ltr"}>
        <label>
          <input
            checked={showCloseButton}
            onChange={(event) => setShowCloseButton(event.target.checked)}
            type="checkbox"
          />
          Show close button
        </label>
        <label>
          <input
            checked={veto}
            onChange={(event) => setVeto(event.target.checked)}
            type="checkbox"
          />
          Reject close
        </label>
        <DialogProvider
          labels={{
            close: locale === "en" ? "Close" : "إغلاق",
            unsavedChanges:
              locale === "en"
                ? "Unsaved changes. Press Esc again to discard"
                : "تغييرات غير محفوظة. اضغط على Esc مرة أخرى لتجاهلها",
          }}
        >
          <Dialog
            {...(controlled
              ? {
                  open,
                  onOpenChange: (next: boolean) => {
                    if (next || !veto) {
                      setOpen(next);
                    }
                  },
                }
              : {})}
          >
            <DialogTrigger>Open editor</DialogTrigger>
            <DialogPopup showCloseButton={showCloseButton}>
              <DialogTitle>Edit question</DialogTitle>
              {registration === "form" ? (
                <Form dirty={dirty} onDiscard={discard}>
                  <label>
                    Question
                    <Input
                      onChange={(event) => setValue(event.target.value)}
                      value={value}
                    />
                  </label>
                </Form>
              ) : (
                <>
                  <DialogFormState dirty={dirty} onDiscard={discard} />
                  <label>
                    Question
                    <Input
                      onChange={(event) => setValue(event.target.value)}
                      value={value}
                    />
                  </label>
                </>
              )}
              <Dialog>
                <DialogTrigger>Open nested editor</DialogTrigger>
                <DialogPopup>
                  <DialogTitle>Nested editor</DialogTitle>
                  <Input aria-label="Nested field" />
                </DialogPopup>
              </Dialog>
              <DialogClose>Cancel</DialogClose>
            </DialogPopup>
          </Dialog>
          <DialogTrigger
            handle={handle}
            payload={{ label: "Handled question" }}
          >
            Open handled editor
          </DialogTrigger>
          <Dialog handle={handle}>
            {({ payload }) => (
              <DialogPopup>
                <DialogTitle>Handled editor</DialogTitle>
                {payload !== undefined && (
                  <output aria-label="Trigger payload">{payload.label}</output>
                )}
              </DialogPopup>
            )}
          </Dialog>
        </DialogProvider>
      </DirectionProvider>
      <output aria-label="Stored draft">{value}</output>
    </main>
  );
};

const root = document.querySelector("#root");
if (root === null) {
  panic("Missing dialog fixture root");
}
createRoot(root).render(<DialogFixture />);
