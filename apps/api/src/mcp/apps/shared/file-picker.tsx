import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { DirectionProvider } from "@base-ui/react/direction-provider";
import type { App } from "@modelcontextprotocol/ext-apps";
import { panic } from "better-result";

import { Button } from "@stll/ui/button";
import { Field, FieldLabel } from "@stll/ui/field";
import { FileInput } from "@stll/ui/file-input";

import { applyHostStyles } from "./bridge";
import { appLocale, isAppMessageKey } from "./locale";
import "./generated/style.css";

export const mountFilePicker = () => {
  const container = document.querySelector<HTMLElement>("#app");
  const messageKey = (element: HTMLElement | null) => {
    const key = element?.dataset["message"];
    if (!key || !isAppMessageKey(key)) {
      panic("File picker is missing a catalog message key");
    }
    return key;
  };
  const title = messageKey(document.querySelector<HTMLElement>("#title"));
  const action = messageKey(document.querySelector<HTMLElement>("#upload"));
  if (!container) {
    panic("File picker markup is incomplete");
  }
  const caption = document.querySelector("p#target");
  const noteElement = document.querySelector<HTMLElement>(".note");
  const note = noteElement ? messageKey(noteElement) : undefined;
  const fields = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[type="file"]'),
    (input) => {
      const label = messageKey(
        input.closest("label")?.querySelector("span") ?? null,
      );
      if (!input.id) {
        panic("File picker field is missing its label or id");
      }
      return { id: input.id, label, accept: input.accept || undefined };
    },
  );
  const files = new Map<string, File>();
  let uploadEnabled = false;
  let activity: "idle" | "uploading" = "idle";
  let locale = appLocale(undefined);
  let captionText = () => locale.t("connecting");
  let statusText = () => "";
  let statusState: "idle" | "error" | "success" = "idle";
  const root = createRoot(container);
  const render = () => {
    document.documentElement.lang = locale.locale;
    document.documentElement.dir = locale.direction;
    document.title = locale.t(messageKey(document.querySelector("title")));
    flushSync(() =>
      root.render(
        <DirectionProvider direction={locale.direction}>
          <main
            dir={locale.direction}
            aria-labelledby="title"
            className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6"
          >
            <h1 id="title" className="text-base font-semibold tracking-tight">
              {locale.t(title)}
            </h1>
            <div className="max-w-xl space-y-4">
              {caption && (
                <p
                  id="target"
                  className="text-muted-foreground text-sm break-words"
                >
                  {captionText()}
                </p>
              )}
              {note && (
                <p className="text-muted-foreground text-sm">
                  {locale.t(note)}
                </p>
              )}
              {fields.map(({ id, label, accept }) => (
                <Field key={id} className="gap-1.5">
                  <FieldLabel
                    id={`${id}-label`}
                    className="text-muted-foreground text-xs"
                  >
                    {locale.t(label)}
                  </FieldLabel>
                  <FileInput
                    disabled={activity === "uploading"}
                    aria-labelledby={`${id}-label`}
                    accept={accept}
                    file={files.get(id) ?? null}
                    chooseLabel={locale.messages.chooseFile}
                    emptyLabel={locale.messages.noFileChosen}
                    onFileChange={(file) => {
                      files.set(id, file);
                      render();
                      container.dispatchEvent(new Event("fileschanged"));
                    }}
                  />
                </Field>
              ))}
              <div className="flex justify-end">
                <Button
                  id="upload"
                  disabled={!uploadEnabled || activity === "uploading"}
                >
                  {locale.t(action)}
                </Button>
              </div>
              <p
                id="status"
                role="status"
                aria-live="polite"
                className={`text-sm empty:hidden status-${statusState}`}
              >
                {statusText()}
              </p>
            </div>
          </main>
        </DirectionProvider>,
      ),
    );
  };
  render();
  return {
    translate: (
      key: Parameters<typeof locale.t>[0],
      values?: Parameters<typeof locale.t>[1],
    ) => locale.t(key, values),
    setCaption: (text: () => string) => {
      captionText = text;
      render();
    },
    setStatus: (text: () => string, state: typeof statusState) => {
      statusText = text;
      statusState = state;
      render();
    },
    getFile: (id: string) => files.get(id),
    setUploadEnabled: (enabled: boolean) => {
      uploadEnabled = enabled;
      render();
    },
    setActivity: (next: typeof activity) => {
      activity = next;
      render();
    },
    clearFiles: () => {
      files.clear();
      render();
    },
    applyHostContext: (context: ReturnType<App["getHostContext"]>) => {
      if (!context) {
        return;
      }
      if (context.locale !== undefined) {
        locale = appLocale(context.locale);
        render();
      }
      applyHostStyles(context);
    },
    onFilesChanged: (callback: () => void) =>
      container.addEventListener("fileschanged", callback),
  };
};
