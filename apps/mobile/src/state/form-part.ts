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

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- only an interface merges into the global FormData
  interface FormData {
    /** Expo's `fetch` sends any part it can read the bytes of. */
    // oxlint-disable-next-line typescript/method-signature-style -- a method adds an overload; a property would replace the DOM's
    append(name: string, value: FormPart): void;
  }
}
