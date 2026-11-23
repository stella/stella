export type ConversionRefusal =
  | { kind: "unsupported_encoding"; encoding: string }
  | {
      kind: "unsupported_reference";
      format: string;
      element: string;
      attribute: string;
    }
  | { kind: "unsupported_field"; fieldType: string }
  | { kind: "legacy_format"; replacementExtension: ".xlsx" | ".pptx" }
  /**
   * An image this deployment makes no preview of: it does not decode the
   * format (`decoding_off`), or the file's pictures cannot be read
   * (`unreadable`). `format` is its short tag ("HEIC").
   */
  | {
      kind: "no_preview";
      format: string;
      cause: "decoding_off" | "unreadable";
    };
