/**
 * A file in a multipart upload as the app's `fetch` reads it. That `fetch`
 * is Expo's, installed globally: it takes each file part's bytes, name and
 * type, and refuses React Native's `{ uri }` part. Expo's `File` is one, so
 * a file on the phone goes up as itself.
 */
export type FormPart = {
  readonly name: string;
  readonly type: string;
  readonly bytes: () => Promise<Uint8Array>;
};

/**
 * A file on the phone as a part of the type the server takes. The type of
 * Expo's `File` is the platform's guess from the name, and Android guesses
 * `audio/mpeg` for a recording the server only takes as `audio/mp4`, so an
 * upload states its type rather than reading it from the file.
 */
export const partOfType = (file: FormPart, type: string): FormPart => ({
  name: file.name,
  type,
  bytes: async () => await file.bytes(),
});

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- only an interface merges into the global FormData
  interface FormData {
    /** Expo's `fetch` sends any part it can read the bytes of. */
    // oxlint-disable-next-line typescript/method-signature-style -- a method adds an overload; a property would replace the DOM's
    append(name: string, value: FormPart): void;
  }
}
