import type { FormPart } from "@/state/form-part";

/**
 * The global `FormData` as the app's `fetch` sees it on the phone. Expo's
 * patch keeps a part it can read the bytes of as the object itself, where
 * Bun's turns it into text, so a test that reads a sent file part installs
 * this one and reads the part with `part`.
 */
export class ExpoFormData extends FormData {
  readonly #parts = new Map<string, FormPart>();

  override append(
    name: string,
    value: string | Blob | FormPart,
    fileName?: string,
  ): void {
    if (typeof value === "string") {
      super.append(name, value);
      return;
    }
    if (value instanceof Blob) {
      super.append(name, value, fileName);
      return;
    }
    this.#parts.set(name, value);
    super.append(name, "");
  }

  /** The file part under `name`, as Expo's `fetch` would read it. */
  part(name: string): FormPart | undefined {
    return this.#parts.get(name);
  }
}
