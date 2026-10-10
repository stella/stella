import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { DirectionProvider } from "@base-ui/react/direction-provider";
import { panic } from "better-result";

import { Button } from "@stll/ui/button";
import { Field, FieldLabel } from "@stll/ui/field";
import { FileInput } from "@stll/ui/file-input";

import { appLocale } from "./locale";
import "./generated/style.css";

export const mountFilePicker = () => {
  const container = document.querySelector<HTMLElement>("#app");
  const title = document.querySelector("#title")?.textContent;
  const action = document.querySelector("#upload")?.textContent;
  if (!container || !title || !action) {
    panic("File picker markup is incomplete");
  }
  const caption = document.querySelector("p#target");
  const note = document.querySelector(".note")?.textContent;
  const fields = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[type="file"]'),
    (input) => {
      const label = input.closest("label")?.querySelector("span")?.textContent;
      if (!label || !input.id) {
        panic("File picker field is missing its label or id");
      }
      return { id: input.id, label, accept: input.accept || undefined };
    },
  );
  const files = new Map<string, File>();
  let uploadEnabled = false;
  let activity: "idle" | "uploading" = "idle";
  let locale = appLocale(undefined);
  const root = createRoot(container);
  const render = () =>
    flushSync(() =>
      root.render(
        <DirectionProvider direction={locale.direction}>
          <main
            dir={locale.direction}
            aria-labelledby="title"
            className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6"
          >
            <h1 id="title" className="text-base font-semibold tracking-tight">
              {title}
            </h1>
            <div className="max-w-xl space-y-4">
              {caption && (
                <p
                  id="target"
                  className="text-muted-foreground text-sm break-words"
                >
                  {caption.textContent}
                </p>
              )}
              {note && <p className="text-muted-foreground text-sm">{note}</p>}
              {fields.map(({ id, label, accept }) => (
                <Field key={id} className="gap-1.5">
                  <FieldLabel
                    id={`${id}-label`}
                    className="text-muted-foreground text-xs"
                  >
                    {label}
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
                  {action}
                </Button>
              </div>
              <p
                id="status"
                role="status"
                aria-live="polite"
                className="text-sm empty:hidden"
              />
            </div>
          </main>
        </DirectionProvider>,
      ),
    );
  render();
  return {
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
    setLocale: (hostLocale: string | undefined) => {
      locale = appLocale(hostLocale);
      document.documentElement.lang = locale.locale;
      document.documentElement.dir = locale.direction;
      render();
    },
    onFilesChanged: (callback: () => void) =>
      container.addEventListener("fileschanged", callback),
  };
};
