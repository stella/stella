export type ConversionRefusal =
  | { kind: "unsupported_encoding"; encoding: string }
  | {
      kind: "unsupported_reference";
      format: string;
      element: string;
      attribute: string;
    }
  | { kind: "unsupported_field"; fieldType: string }
  | { kind: "legacy_format"; replacementExtension: ".xlsx" | ".pptx" };
