export type PinSource =
  | {
      readonly type: "manifest";
      readonly file: string;
      readonly section:
        "catalog" | "dependencies" | "devDependencies" | "resolutions";
      readonly package: string;
    }
  | { readonly type: "image"; readonly file: string; readonly name: string }
  | { readonly type: "constant"; readonly file: string; readonly name: string };

export type FixtureProvenanceKind =
  "recorded" | "synthetic-from-spec" | "redacted-prod-shape";

export type FixtureSet = {
  readonly path: string;
  readonly replayFiles: readonly [string, ...string[]];
  readonly replay:
    | "fetch-replay"
    | "schema-validation"
    | "parser-replay"
    | "container"
    | "wire-fake";
  readonly provenance:
    | {
        readonly type: "sidecars";
        readonly format:
          "provider-wire" | "provider-request-schemas" | "fixture-provenance";
      }
    | { readonly type: "authored"; readonly kind: FixtureProvenanceKind };
} & (
  | { readonly metadata: string }
  | { readonly pinMetadata: "provider-request-schemas" }
  | {
      readonly provenance: {
        readonly type: "sidecars";
        readonly format: "fixture-provenance";
      };
    }
);

type ExternalContractBase = {
  readonly owners: readonly {
    readonly path: string;
    readonly role: "primary" | "shared";
  }[];
  readonly sdks: readonly string[];
  readonly pinSources: readonly PinSource[];
  readonly driftTriggers: readonly string[];
};

export type ExternalContractEntry = ExternalContractBase &
  (
    | {
        readonly status: "characterised";
        readonly fixtures: readonly [FixtureSet, ...FixtureSet[]];
        readonly uncharacterisedScope: {
          readonly owners: readonly {
            readonly path: string;
            readonly reason: string;
          }[];
          readonly sdks: readonly {
            readonly package: string;
            readonly reason: string;
          }[];
        };
      }
    | { readonly status: "uncharacterised"; readonly reason: string }
  );
