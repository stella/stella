import { library } from "@stll/oxlint-config";

export default library({
  options: {
    reportUnusedDisableDirectives: "off",
  },
  ignorePatterns: [
    ".turbo/",
    ".claude/worktrees/",
    "packages/benchmark/vendor/",
    "packages/*/dist/",
    "packages/anonymize/wasm/dist/",
  ],
  jsPlugins: ["./oxlint.plugin.ts"],
  rules: {
    "stll/no-double-assertion": "error",
    "stll/no-dynamic-import-specifier": "error",
    "no-non-null-assertion": "off",
    "require-await": "off",
    "typescript/dot-notation": "off",
    "typescript/no-unnecessary-condition": "off",
    "typescript/prefer-nullish-coalescing": "off",
    "typescript/strict-boolean-expressions": "off",
  },
  overrides: [
    {
      // JavaScript cannot express the required parse-to-unknown handoff.
      files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
      rules: {
        "stll/no-unchecked-json-parse-typing": "error",
      },
    },
    {
      // Runtime-parity fixtures deliberately construct malformed values. The
      // production rules still cover every shipped package source.
      files: ["**/__test__/**", "**/*.test.ts"],
      rules: {
        "stll/no-double-assertion": "off",
        "stll/no-unchecked-json-parse-typing": "off",
      },
    },
    {
      // Existing transport decoders being migrated to validated codecs. Keep
      // this list file-specific so new violations elsewhere fail immediately.
      files: [
        "packages/anonymize/src/native.ts",
        "packages/anonymize/src/native-pipeline.ts",
        "packages/anonymize/src/wasm-binding.ts",
      ],
      rules: {
        "stll/no-unchecked-json-parse-typing": "off",
      },
    },
    {
      files: [".github/tools/**", "eval-html.ts"],
      rules: {
        "no-console": "off",
        "typescript/no-unnecessary-condition": "off",
        "typescript/strict-boolean-expressions": "off",
      },
    },
    {
      files: ["packages/corpus/src/**"],
      rules: {
        "no-console": "off",
      },
    },
    {
      files: ["packages/data/dictionaries/index.ts"],
      rules: {
        "promise/always-return": "off",
        "typescript/no-confusing-void-expression": "off",
      },
    },
    {
      // Computed import() is safe where imports resolve at runtime
      // instead of being bundled: tests and bench resolve package
      // subpaths from node_modules. The data package is not exempt;
      // its dictionaries reach bundled consumers through literal
      // specifier maps (LOADERS, CITY_LOADERS).
      files: ["packages/bench/**", "**/__test__/**"],
      rules: {
        "stll/no-dynamic-import-specifier": "off",
      },
    },
  ],
});
