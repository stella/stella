// A file the rule accepts besides the owner itself. `path` is a
// repo-relative file path, or a directory prefix ending in "/".
export type AllowedFile = {
  readonly path: string;
  readonly reason: string;
};

export type OwnershipEnforcement =
  | { readonly kind: "none" }
  | {
      readonly kind: "literal-pattern";
      readonly pattern: string;
      readonly allowed: readonly AllowedFile[];
    }
  | {
      readonly kind: "status-set";
      readonly columns: Readonly<Record<string, readonly string[]>>;
      readonly allowed: readonly AllowedFile[];
    }
  | {
      readonly kind: "import";
      readonly specifiers: readonly string[];
      // When set, only an import of one of these bindings (or a namespace
      // import, which reaches all of them) is confined; the specifiers'
      // other exports stay open. For a package whose entry points also
      // carry unrelated exports.
      readonly names?: readonly string[];
      readonly allowed: readonly AllowedFile[];
    }
  | {
      readonly kind: "global-member";
      readonly object: string;
      // The member chain below `object`, e.g. `["clipboard", "writeText"]`
      // for `navigator.clipboard.writeText`. A sibling member of the same
      // object is a different capability and is not matched.
      readonly path: readonly string[];
      readonly allowed: readonly AllowedFile[];
    }
  | {
      readonly kind: "member-call";
      // A call of this method on any receiver. The name alone is common, so
      // the rule applies only under the `within` path prefixes.
      readonly method: string;
      readonly within: readonly string[];
      readonly allowed: readonly AllowedFile[];
    }
  | {
      readonly kind: "function-call";
      readonly name: string;
      readonly within: readonly string[];
      readonly allowed: readonly AllowedFile[];
    };

export type OwnershipEntry = {
  readonly id: string;
  readonly group?: "root-connection";
  readonly capability: string;
  readonly owner: readonly string[];
  readonly summary: string;
  readonly enforcement: OwnershipEnforcement;
};
