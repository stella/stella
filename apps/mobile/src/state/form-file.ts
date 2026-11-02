/**
 * A file on the phone as React Native's multipart upload names one: by its
 * location, which the platform streams from disk.
 */
export type FormFile = {
  readonly uri: string;
  readonly name: string;
  readonly type: string;
};

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- only an interface merges into the global FormData
  interface FormData {
    /**
     * React Native's `FormData` also takes a file by its location and
     * streams it from disk; the DOM typings know only `Blob`s.
     */
    // oxlint-disable-next-line typescript/method-signature-style -- a method adds an overload; a property would replace the DOM's
    append(name: string, value: FormFile): void;
  }
}
