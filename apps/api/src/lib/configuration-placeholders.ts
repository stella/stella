/**
 * Values that mean "nothing has been supplied for this variable yet".
 *
 * The empty string is the shape a cleared variable takes; the remaining
 * literals are seeded by provisioning tooling so a parameter exists before a
 * human fills it in. Without this set a seeded literal validates as a real
 * value and reaches a client, so every sentinel check routes through here:
 * an optional variable reads as absent, a required one fails validation.
 *
 * Casing and stray whitespace around a literal cannot turn a placeholder back
 * into a value.
 */
export const CONFIGURATION_PLACEHOLDERS = [
  "",
  "use-iam-role",
  "placeholder_set_me",
  "unconfigured",
] as const;

const PLACEHOLDER_LITERALS: ReadonlySet<string> = new Set(
  CONFIGURATION_PLACEHOLDERS.filter((placeholder) => placeholder !== ""),
);

/**
 * Variables where the empty string is a value rather than an absence. Only a
 * database password qualifies: an empty one is valid, so it must survive
 * normalisation. Every other variable treats empty as unset and takes its
 * default. The seeded literals still read as unset here.
 */
export const EMPTY_VALUE_VARIABLES: ReadonlySet<string> = new Set([
  "DB_PASSWORD",
]);

/**
 * The empty string matches exactly, while the seeded literals match after
 * trim + lowercase: a whitespace-only value is a malformed value rather than
 * an unset one, and must keep failing its own variable's schema.
 */
export const isConfigurationPlaceholder = (value: string): boolean =>
  value === "" || PLACEHOLDER_LITERALS.has(value.trim().toLowerCase());

const isPlaceholderForVariable = (name: string, value: string): boolean =>
  value === ""
    ? !EMPTY_VALUE_VARIABLES.has(name)
    : PLACEHOLDER_LITERALS.has(value.trim().toLowerCase());

/** The `type` valibot gives a schema that accepts an absent value. */
const OPTIONAL_SCHEMA_TYPE = "optional";

/** The only part of an env schema entry this module reads. */
type EnvSchemaEntry = { readonly type: string };

type RuntimeEnvValues = Record<string, string | undefined>;

type ConfigurationPlaceholderResolution = {
  /** `values` with every declared placeholder replaced by undefined. */
  runtimeEnv: RuntimeEnvValues;
  /** Set when a variable that needs a real value held a placeholder. */
  violation: string | null;
};

type ResolveConfigurationPlaceholdersOptions = {
  /** Schema read for the variable names and their optionality. */
  schema: Record<string, EnvSchemaEntry>;
  /** Raw values, typically `process.env`. */
  values: RuntimeEnvValues;
  /**
   * Variables that assemble a derived value instead of being read directly.
   * Each is individually optional, but a placeholder in one is never an
   * intentional "unset": it would vanish from what gets assembled and leave a
   * usable-looking result behind, so it is always reported by name.
   */
  derivationInputs?: Record<string, EnvSchemaEntry>;
};

/**
 * Strip placeholders before anything reads the values, derivations included.
 * Callers pass `runtimeEnv` on to validation and turn a non-null `violation`
 * into a boot failure; the message names the offending variables so the fix
 * is obvious from the log.
 */
export const resolveConfigurationPlaceholders = ({
  schema,
  values,
  derivationInputs = {},
}: ResolveConfigurationPlaceholdersOptions): ConfigurationPlaceholderResolution => {
  const runtimeEnv: RuntimeEnvValues = { ...values };
  const reported: string[] = [];
  const scan = (
    entries: Record<string, EnvSchemaEntry>,
    alwaysReport: boolean,
  ) => {
    for (const [name, entry] of Object.entries(entries)) {
      // Read the input, not the accumulator: a variable listed in both
      // `schema` and `derivationInputs` must be judged the same either way.
      const value = values[name];
      if (typeof value !== "string" || !isPlaceholderForVariable(name, value)) {
        continue;
      }
      runtimeEnv[name] = undefined;
      // Only a seeded literal is worth naming. An empty value is unset, and
      // reporting it here would pre-empt the schema (or a derivation that
      // falls back to another input) that already handles an absent value.
      if (
        value !== "" &&
        (alwaysReport || entry.type !== OPTIONAL_SCHEMA_TYPE)
      ) {
        reported.push(name);
      }
    }
  };
  scan(schema, false);
  scan(derivationInputs, true);
  return {
    runtimeEnv,
    violation:
      reported.length === 0
        ? null
        : `${reported.join(", ")} must be set to a real value; the configured value is a placeholder.`,
  };
};
