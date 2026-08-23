import type { PythonAdapterOptions } from "./python";

export const PRESIDIO_PROVIDER = {
  name: "presidio",
  venvDir: ".venv-presidio",
  script: "presidio_adapter.py",
  languageSupport: {
    type: "allowlist",
    languages: ["en", "de", "es", "cs"],
  },
} as const satisfies PythonAdapterOptions;

export const SCRUBADUB_PROVIDER = {
  name: "scrubadub",
  venvDir: ".venv-scrubadub",
  script: "scrubadub_adapter.py",
  languageSupport: { type: "all" },
} as const satisfies PythonAdapterOptions;

export const DATAFOG_PROVIDER = {
  name: "datafog",
  venvDir: ".venv-datafog",
  script: "datafog_adapter.py",
  languageSupport: { type: "all" },
} as const satisfies PythonAdapterOptions;

/** Optional Python providers executed by every sealed runner. */
export const PYTHON_BENCHMARK_PROVIDERS = [
  PRESIDIO_PROVIDER,
  SCRUBADUB_PROVIDER,
  DATAFOG_PROVIDER,
] as const;
