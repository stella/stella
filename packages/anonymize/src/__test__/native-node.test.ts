import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CALLER_DETECTION_REQUEST_JSON_MAX_BYTES,
  NATIVE_BINDING_PARITY_MEMBERS,
  PreparedNativeAnonymizer,
  SESSION_CALLER_INPUTS_JSON_MAX_BYTES,
  type NativeAnonymizeBinding,
  type NativeCallerDetection,
  type NativeDiagnosticsBatchCallback,
  type NativePreparedRedactionSessionBinding,
  type NativePreparedSearchBinding,
} from "../native";
import {
  available_default_native_pipeline_languages,
  availableDefaultNativePipelineLanguages,
  create_native_pipeline_from_default_package,
  create_pipeline,
  createPipeline,
  createNativePipelineFromDefaultPackage,
  createNativePipelineFromPackageFile,
  diagnostics_json,
  diagnostics_stream_json,
  get_default_native_pipeline,
  getDefaultNativePipeline,
  load_prepared_package,
  load_prepared_package_file,
  loadNativeAnonymizeBinding,
  native_package_version,
  normalize_for_search,
  preload_default_native_pipeline,
  preloadDefaultNativePipeline,
  preloadDefaultNativePipelineAsync,
  prepare_search_package,
  read_default_native_pipeline_package_file,
  readDefaultNativePipelinePackageFile,
  readNativePipelinePackageFile,
  readNativePipelinePackageFileAsync,
  redact_default_text,
  redact_default_text_json,
  redact_text,
  redact_text_json,
  redact_text_stream_json,
  summary_diagnostics_json,
  type PipelineLanguageSelection,
} from "../native-node";
import {
  SHARED_NATIVE_SDK_DEFAULT_PACKAGE_FUNCTIONS,
  SHARED_NATIVE_SDK_TOP_LEVEL_FUNCTIONS,
} from "../native-sdk-contract";

const packageJsonVersion = (): string => {
  const packageJson = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../package.json", import.meta.url)),
      {
        encoding: "utf8",
      },
    ),
  ) as { version?: unknown };
  if (typeof packageJson.version !== "string") {
    throw new TypeError("Package version is missing");
  }
  return packageJson.version;
};

const PACKAGE_VERSION = packageJsonVersion();
const MISMATCHED_PACKAGE_VERSION =
  PACKAGE_VERSION === "0.0.0" ? "999.999.999" : "0.0.0";

const captureCreatePipelineFailure = async (options: unknown) => {
  try {
    await Promise.resolve(Reflect.apply(createPipeline, undefined, [options]));
  } catch (error) {
    return error;
  }
  throw new Error("createPipeline did not reject invalid options");
};

describe("native node loader", () => {
  test("uses the embedded loader for explicit host target values", () => {
    const loaded = loadNativeAnonymizeBinding({
      arch: process.arch,
      expectedVersion: PACKAGE_VERSION,
      platform: process.platform,
    });

    expect(loaded.nativePackageVersion()).toBe(PACKAGE_VERSION);
  });

  test("unwraps the selected platform package", () => {
    const calls: string[] = [];
    const binding = fakeNativeBinding(PACKAGE_VERSION);
    const loaded = loadNativeAnonymizeBinding({
      expectedVersion: PACKAGE_VERSION,
      platform: "darwin",
      arch: "arm64",
      env: {},
      requireModule: (specifier) => {
        calls.push(specifier);
        if (specifier === "@stll/anonymize-darwin-arm64") {
          return { default: binding };
        }
        throw new Error("not found");
      },
    });

    expect(loaded).toBe(binding);
    expect(calls).toEqual(["@stll/anonymize-darwin-arm64"]);
  });

  for (const member of NATIVE_BINDING_PARITY_MEMBERS.root) {
    test(`rejects a binding missing root parity member: ${member}`, () => {
      const binding = fakeNativeBinding(PACKAGE_VERSION);
      const incomplete = { ...binding, [member]: undefined };
      expect(() =>
        loadNativeAnonymizeBinding({
          expectedVersion: PACKAGE_VERSION,
          platform: "darwin",
          arch: "arm64",
          env: {},
          requireModule: (specifier) => {
            if (specifier === "@stll/anonymize-darwin-arm64") {
              return incomplete;
            }
            throw new Error("not found");
          },
        }),
      ).toThrow("does not match native binding shape");
    });
  }

  for (const member of NATIVE_BINDING_PARITY_MEMBERS.factories) {
    test(`rejects a binding missing prepared factory: ${member}`, () => {
      const binding = fakeNativeBinding(PACKAGE_VERSION);
      const incomplete = {
        ...binding,
        NativePreparedSearch: {
          ...binding.NativePreparedSearch,
          [member]: undefined,
        },
      };
      expect(() =>
        loadNativeAnonymizeBinding({
          expectedVersion: PACKAGE_VERSION,
          platform: "darwin",
          arch: "arm64",
          env: {},
          requireModule: (specifier) => {
            if (specifier === "@stll/anonymize-darwin-arm64") {
              return incomplete;
            }
            throw new Error("not found");
          },
        }),
      ).toThrow("does not match native binding shape");
    });
  }

  test("falls back to the platform native package", () => {
    const calls: string[] = [];
    const binding = fakeNativeBinding(PACKAGE_VERSION);
    const loaded = loadNativeAnonymizeBinding({
      expectedVersion: PACKAGE_VERSION,
      platform: "darwin",
      arch: "arm64",
      env: {},
      requireModule: (specifier) => {
        calls.push(specifier);
        if (specifier === "@stll/anonymize-darwin-arm64") {
          return binding;
        }
        throw new Error("not found");
      },
    });

    expect(loaded).toBe(binding);
    expect(calls).toEqual(["@stll/anonymize-darwin-arm64"]);
  });

  test("selects the Linux GNU platform package", () => {
    const calls: string[] = [];
    const binding = fakeNativeBinding(PACKAGE_VERSION);
    const loaded = loadNativeAnonymizeBinding({
      expectedVersion: PACKAGE_VERSION,
      platform: "linux",
      arch: "x64",
      libc: "gnu",
      env: {},
      requireModule: (specifier) => {
        calls.push(specifier);
        if (specifier === "@stll/anonymize-linux-x64-gnu") {
          return binding;
        }
        throw new Error("not found");
      },
    });

    expect(loaded).toBe(binding);
    expect(calls).toEqual(["@stll/anonymize-linux-x64-gnu"]);
  });

  test("reports unsupported native targets with an actionable error", () => {
    const calls: string[] = [];
    const attempt = () =>
      loadNativeAnonymizeBinding({
        expectedVersion: PACKAGE_VERSION,
        platform: "linux",
        arch: "x64",
        libc: "musl",
        env: {},
        requireModule: (specifier) => {
          calls.push(specifier);
          throw new Error("not found");
        },
      });

    expect(attempt).toThrow(
      "No native anonymize binding is published for linux-x64-musl",
    );
    expect(attempt).toThrow("linux-x64-gnu");
    expect(attempt).toThrow("STELLA_ANONYMIZE_NATIVE_LIBRARY_PATH");
    // musl resolves to no published sidecar, so no module is loaded.
    expect(calls).toEqual([]);
  });

  test("prefers an explicit native library path on unsupported targets", () => {
    const binding = fakeNativeBinding(PACKAGE_VERSION);
    const loaded = loadNativeAnonymizeBinding({
      expectedVersion: PACKAGE_VERSION,
      platform: "linux",
      arch: "x64",
      libc: "musl",
      env: { STELLA_ANONYMIZE_NATIVE_LIBRARY_PATH: "/tmp/anonymize.node" },
      requireModule: (specifier) => {
        if (specifier === "/tmp/anonymize.node") {
          return { default: binding };
        }
        throw new Error("not found");
      },
    });

    expect(loaded).toBe(binding);
  });

  test("loads an explicit native library path first", () => {
    const calls: string[] = [];
    const binding = fakeNativeBinding(PACKAGE_VERSION);
    const loaded = loadNativeAnonymizeBinding({
      expectedVersion: PACKAGE_VERSION,
      env: { STELLA_ANONYMIZE_NATIVE_LIBRARY_PATH: "/tmp/anonymize.node" },
      requireModule: (specifier) => {
        calls.push(specifier);
        if (specifier === "/tmp/anonymize.node") {
          return { default: binding };
        }
        throw new Error("not found");
      },
    });

    expect(loaded).toBe(binding);
    expect(calls).toEqual(["/tmp/anonymize.node"]);
  });

  test("accepts a napi class constructor on the native binding", () => {
    const calls: string[] = [];
    const binding = fakeNativeBinding(PACKAGE_VERSION, {
      preparedSearchAsConstructor: true,
    });
    const loaded = loadNativeAnonymizeBinding({
      expectedVersion: PACKAGE_VERSION,
      platform: "darwin",
      arch: "arm64",
      env: {},
      requireModule: (specifier) => {
        calls.push(specifier);
        if (specifier === "@stll/anonymize-darwin-arm64") {
          return binding;
        }
        throw new Error("not found");
      },
    });

    expect(loaded).toBe(binding);
  });

  test("rejects mismatched native binding versions", () => {
    expect(() =>
      loadNativeAnonymizeBinding({
        expectedVersion: PACKAGE_VERSION,
        platform: "darwin",
        arch: "arm64",
        env: {},
        requireModule: (specifier) => {
          if (specifier === "@stll/anonymize-darwin-arm64") {
            return fakeNativeBinding(MISMATCHED_PACKAGE_VERSION);
          }
          throw new Error("not found");
        },
      }),
    ).toThrow(`does not match ${PACKAGE_VERSION}`);
  });

  test("loads native pipeline package bytes from a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "anonymize-native-package-"));
    const packagePath = join(dir, "pipeline.stlanonpkg");
    try {
      writeFileSync(packagePath, Uint8Array.of(1, 2, 3, 4));

      expect([...readNativePipelinePackageFile(packagePath)]).toEqual([
        1, 2, 3, 4,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loads native pipeline package bytes from a file asynchronously", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anonymize-native-package-"));
    const packagePath = join(dir, "pipeline.stlanonpkg");
    try {
      writeFileSync(packagePath, Uint8Array.of(4, 3, 2, 1));

      expect([
        ...(await readNativePipelinePackageFileAsync(packagePath)),
      ]).toEqual([4, 3, 2, 1]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("creates a native pipeline from a package file", () => {
    const dir = mkdtempSync(join(tmpdir(), "anonymize-native-pipeline-"));
    const packagePath = join(dir, "pipeline.stlanonpkg");
    const capturedBytes: number[][] = [];
    try {
      writeFileSync(packagePath, Uint8Array.of(7, 8, 9));
      const binding = fakeNativeBinding(PACKAGE_VERSION, {
        onPreparedPackageBytes: (bytes) => {
          capturedBytes.push([...bytes]);
        },
      });

      const pipeline = createNativePipelineFromPackageFile({
        binding,
        expectedVersion: PACKAGE_VERSION,
        packagePath,
      });

      expect(capturedBytes).toEqual([[7, 8, 9]]);
      expect(pipeline.redactText("x").redaction.redactedText).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("creates a native pipeline from the default package path override", () => {
    const dir = mkdtempSync(join(tmpdir(), "anonymize-default-pipeline-"));
    const packagePath = join(dir, "native-pipeline.stlanonpkg");
    const capturedBytes: number[][] = [];
    try {
      writeFileSync(packagePath, Uint8Array.of(10, 11, 12));
      const binding = fakeNativeBinding(PACKAGE_VERSION, {
        onTrustedPreparedPackageBytesWithoutCache: (bytes) => {
          capturedBytes.push([...bytes]);
        },
      });

      const pipeline = createNativePipelineFromDefaultPackage({
        binding,
        packagePath,
        expectedVersion: PACKAGE_VERSION,
      });

      expect(capturedBytes).toEqual([[10, 11, 12]]);
      expect(pipeline.redactText("x").redaction.redactedText).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("prefers the trusted native package no-cache factory for default packages", () => {
    const dir = mkdtempSync(join(tmpdir(), "anonymize-default-trusted-"));
    const packagePath = join(dir, "native-pipeline.stlanonpkg");
    const trustedNoCacheBytes: number[][] = [];
    const trustedCachedBytes: number[][] = [];
    const verifiedBytes: number[][] = [];
    try {
      writeFileSync(packagePath, Uint8Array.of(22, 23, 24));
      const binding = fakeNativeBinding(PACKAGE_VERSION, {
        onTrustedPreparedPackageBytesWithoutCache: (bytes) => {
          trustedNoCacheBytes.push([...bytes]);
        },
        onTrustedPreparedPackageBytes: (bytes) => {
          trustedCachedBytes.push([...bytes]);
        },
        onPreparedPackageBytesWithoutCache: (bytes) => {
          verifiedBytes.push([...bytes]);
        },
      });

      const pipeline = createNativePipelineFromDefaultPackage({
        binding,
        packagePath,
        expectedVersion: PACKAGE_VERSION,
      });

      expect(trustedNoCacheBytes).toEqual([[22, 23, 24]]);
      expect(trustedCachedBytes).toEqual([]);
      expect(verifiedBytes).toEqual([]);
      expect(pipeline.redactText("x").redaction.redactedText).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("caches the default native pipeline per binding and package path", () => {
    const dir = mkdtempSync(join(tmpdir(), "anonymize-default-cache-"));
    const packagePath = join(dir, "native-pipeline.stlanonpkg");
    const capturedBytes: number[][] = [];
    try {
      writeFileSync(packagePath, Uint8Array.of(13, 14, 15));
      let warmCount = 0;
      const binding = fakeNativeBinding(PACKAGE_VERSION, {
        onTrustedPreparedPackageBytesWithoutCache: (bytes) => {
          capturedBytes.push([...bytes]);
        },
        onWarmLazyRegex: () => {
          warmCount += 1;
        },
      });

      const first = getDefaultNativePipeline({
        binding,
        packagePath,
        expectedVersion: PACKAGE_VERSION,
      });
      const second = getDefaultNativePipeline({
        binding,
        packagePath,
        expectedVersion: PACKAGE_VERSION,
      });
      expect(warmCount).toBe(0);
      const preloaded = preloadDefaultNativePipeline({
        binding,
        packagePath,
        expectedVersion: PACKAGE_VERSION,
      });

      expect(second).toBe(first);
      expect(preloaded).toBe(first);
      expect(capturedBytes).toEqual([[13, 14, 15]]);
      expect(warmCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("can defer default native pipeline warmup", () => {
    const dir = mkdtempSync(join(tmpdir(), "anonymize-default-warmup-"));
    const packagePath = join(dir, "native-pipeline.stlanonpkg");
    try {
      writeFileSync(packagePath, Uint8Array.of(19, 20, 21));
      let warmCount = 0;
      const binding = fakeNativeBinding(PACKAGE_VERSION, {
        onWarmLazyRegex: () => {
          warmCount += 1;
        },
      });

      const cold = getDefaultNativePipeline({
        binding,
        packagePath,
        expectedVersion: PACKAGE_VERSION,
        warmup: "none",
      });
      const stillCold = getDefaultNativePipeline({
        binding,
        packagePath,
        expectedVersion: PACKAGE_VERSION,
        warmup: "none",
      });
      const warmed = getDefaultNativePipeline({
        binding,
        packagePath,
        expectedVersion: PACKAGE_VERSION,
        warmup: "lazy-regex",
      });

      expect(stillCold).toBe(cold);
      expect(warmed).toBe(cold);
      expect(warmCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("preloads the default native pipeline asynchronously", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anonymize-default-async-cache-"));
    const packagePath = join(dir, "native-pipeline.stlanonpkg");
    const capturedBytes: number[][] = [];
    try {
      writeFileSync(packagePath, Uint8Array.of(16, 17, 18));
      let warmCount = 0;
      const binding = fakeNativeBinding(PACKAGE_VERSION, {
        onTrustedPreparedPackageBytesWithoutCache: (bytes) => {
          capturedBytes.push([...bytes]);
        },
        onWarmLazyRegex: () => {
          warmCount += 1;
        },
      });

      const [first, second] = await Promise.all([
        preloadDefaultNativePipelineAsync({
          binding,
          packagePath,
          expectedVersion: PACKAGE_VERSION,
        }),
        preloadDefaultNativePipelineAsync({
          binding,
          packagePath,
          expectedVersion: PACKAGE_VERSION,
        }),
      ]);
      const syncCached = getDefaultNativePipeline({
        binding,
        packagePath,
        expectedVersion: PACKAGE_VERSION,
      });

      expect(second).toBe(first);
      expect(syncCached).toBe(first);
      expect(capturedBytes).toEqual([[16, 17, 18]]);
      expect(warmCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loads language-scoped default native pipeline packages", () => {
    const language = "zz-test";
    const packagePath = fileURLToPath(
      new URL(`../../native-pipeline.${language}.stlanonpkg`, import.meta.url),
    );
    const capturedBytes: number[][] = [];
    try {
      writeFileSync(packagePath, Uint8Array.of(31, 32, 33));
      const binding = fakeNativeBinding(PACKAGE_VERSION, {
        onTrustedPreparedPackageBytesWithoutCache: (bytes) => {
          capturedBytes.push([...bytes]);
        },
      });

      const first = getDefaultNativePipeline({
        binding,
        language: "ZZ-Test",
        expectedVersion: PACKAGE_VERSION,
      });
      const second = getDefaultNativePipeline({
        binding,
        language,
        expectedVersion: PACKAGE_VERSION,
      });

      expect(second).toBe(first);
      expect(availableDefaultNativePipelineLanguages()).toContain(language);
      expect(capturedBytes).toEqual([[31, 32, 33]]);
    } finally {
      rmSync(packagePath, { force: true });
    }
  });

  test("falls back from regional default package languages to base packages", () => {
    const language = "zz";
    const packagePath = fileURLToPath(
      new URL(`../../native-pipeline.${language}.stlanonpkg`, import.meta.url),
    );
    const capturedBytes: number[][] = [];
    try {
      writeFileSync(packagePath, Uint8Array.of(34, 35, 36));
      const binding = fakeNativeBinding(PACKAGE_VERSION, {
        onTrustedPreparedPackageBytesWithoutCache: (bytes) => {
          capturedBytes.push([...bytes]);
        },
      });

      const regional = getDefaultNativePipeline({
        binding,
        language: "ZZ-Test",
        expectedVersion: PACKAGE_VERSION,
      });
      const base = getDefaultNativePipeline({
        binding,
        language,
        expectedVersion: PACKAGE_VERSION,
      });

      expect(base).toBe(regional);
      expect(capturedBytes).toEqual([[34, 35, 36]]);
    } finally {
      rmSync(packagePath, { force: true });
    }
  });

  test("creates and caches an exact multi-language pipeline", async () => {
    const assembledConfigs: unknown[] = [];
    const binding = fakeNativeBinding(PACKAGE_VERSION, {
      onAssembleStaticSearchPackageBytes: (configBytes) => {
        assembledConfigs.push(
          JSON.parse(new TextDecoder().decode(configBytes)),
        );
      },
    });

    const first = await createPipeline({
      binding,
      language: ["en", "cs", "en"],
    });
    const second = await createPipeline({
      binding,
      language: ["cs", "en"],
    });

    expect(second).toBe(first);
    expect(assembledConfigs).toHaveLength(1);
    expect(assembledConfigs.at(0)).toMatchObject({ languages: ["cs", "en"] });
  });

  test("bounds the exact-scope pipeline cache", async () => {
    let preparedPipelineCount = 0;
    const binding = fakeNativeBinding(PACKAGE_VERSION, {
      onPreparedPackageBytes: () => {
        preparedPipelineCount += 1;
      },
    });
    const selections = [
      ["cs", "de"],
      ["cs", "en"],
      ["cs", "es"],
      ["cs", "fr"],
      ["cs", "hu"],
      ["cs", "it"],
      ["cs", "lv"],
      ["cs", "pl"],
      ["cs", "pt-br"],
    ] as const satisfies readonly PipelineLanguageSelection[];

    const first = await createPipeline({
      binding,
      language: selections[0],
    });
    for (const language of selections.slice(1)) {
      await createPipeline({ binding, language });
    }
    const repeated = await createPipeline({
      binding,
      language: selections[0],
    });

    expect(repeated).not.toBe(first);
    expect(preparedPipelineCount).toBe(selections.length + 1);
  });

  test("uses an existing single-language artifact", async () => {
    const packagePath = fileURLToPath(
      new URL("../../native-pipeline.en.stlanonpkg", import.meta.url),
    );
    const createdFixture = !existsSync(packagePath);
    try {
      if (createdFixture) {
        writeFileSync(packagePath, Uint8Array.of(41, 42, 43));
      }
      let trustedLoads = 0;
      const binding = fakeNativeBinding(PACKAGE_VERSION, {
        onTrustedPreparedPackageBytesWithoutCache: () => {
          trustedLoads += 1;
        },
      });

      const first = await createPipeline({ binding, language: "en" });
      const second = await createPipeline({ binding, language: "en" });

      expect(second).toBe(first);
      expect(trustedLoads).toBe(1);
    } finally {
      if (createdFixture) {
        rmSync(packagePath, { force: true });
      }
    }
  });

  test("rejects unsupported semantic language selections before binding", async () => {
    const unsupported = await captureCreatePipelineFailure({ language: "nl" });
    const empty = await captureCreatePipelineFailure({ language: [] });

    expect(unsupported).toBeInstanceOf(Error);
    expect(unsupported).toHaveProperty(
      "message",
      expect.stringContaining("Unsupported pipeline language"),
    );
    expect(empty).toBeInstanceOf(Error);
    expect(empty).toHaveProperty(
      "message",
      expect.stringContaining("must not be empty"),
    );
  });

  test("shared default package SDK helpers expose snake-case aliases", () => {
    const aliasFunctions: Record<
      (typeof SHARED_NATIVE_SDK_DEFAULT_PACKAGE_FUNCTIONS)[number],
      unknown
    > = {
      available_default_native_pipeline_languages,
      create_native_pipeline_from_default_package,
      create_pipeline,
      get_default_native_pipeline,
      preload_default_native_pipeline,
      read_default_native_pipeline_package_file,
      redact_default_text,
      redact_default_text_json,
    };
    for (const name of SHARED_NATIVE_SDK_DEFAULT_PACKAGE_FUNCTIONS) {
      expect(typeof aliasFunctions[name]).toBe("function");
    }

    const language = "zz-alias";
    const languagePackagePath = fileURLToPath(
      new URL(`../../native-pipeline.${language}.stlanonpkg`, import.meta.url),
    );
    const dir = mkdtempSync(join(tmpdir(), "anonymize-default-alias-"));
    const packagePath = join(dir, "native-pipeline.stlanonpkg");
    const capturedBytes: number[][] = [];
    try {
      writeFileSync(languagePackagePath, Uint8Array.of(41, 42, 43));
      writeFileSync(packagePath, Uint8Array.of(44, 45, 46));
      let warmCount = 0;
      const binding = fakeNativeBinding(PACKAGE_VERSION, {
        onTrustedPreparedPackageBytesWithoutCache: (bytes) => {
          capturedBytes.push([...bytes]);
        },
        onWarmLazyRegex: () => {
          warmCount += 1;
        },
      });

      expect([
        ...read_default_native_pipeline_package_file({ language }),
      ]).toEqual([41, 42, 43]);
      expect(available_default_native_pipeline_languages()).toContain(language);

      const created = create_native_pipeline_from_default_package({
        binding,
        packagePath,
        warmup: "none",
      });
      const cached = get_default_native_pipeline({
        binding,
        packagePath,
        warmup: "none",
      });
      const warmed = preload_default_native_pipeline({
        binding,
        packagePath,
      });
      const helperResult = redact_default_text("x", undefined, {
        binding,
        packagePath,
      });
      const helperJson = JSON.parse(
        redact_default_text_json("x", undefined, {
          binding,
          packagePath,
        }),
      );

      expect(warmed).toBe(cached);
      expect(created).not.toBe(cached);
      expect(helperResult.redaction.redactedText).toBe("");
      expect(helperJson).toEqual({
        redaction: {
          entity_count: 0,
          operator_map: [],
          redacted_text: "",
          redaction_map: [],
        },
        resolved_entities: [],
      });
      expect(capturedBytes).toEqual([
        [44, 45, 46],
        [44, 45, 46],
      ]);
      expect(warmCount).toBe(1);
    } finally {
      rmSync(languagePackagePath, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects unsafe default native package language selectors", () => {
    expect(() =>
      readDefaultNativePipelinePackageFile({ language: "../en" }),
    ).toThrow("Default native pipeline language must match");
    expect(() =>
      getDefaultNativePipeline({
        binding: fakeNativeBinding(PACKAGE_VERSION),
        language: "en",
        packagePath: "/tmp/native-pipeline.stlanonpkg",
      }),
    ).toThrow("Use either language or packagePath");
  });

  test("rejects unknown default native pipeline warmup modes", () => {
    const binding = fakeNativeBinding(PACKAGE_VERSION);

    expect(() =>
      Reflect.apply(getDefaultNativePipeline, undefined, [
        {
          binding,
          warmup: "eager",
        },
      ]),
    ).toThrow('Default native pipeline warmup must be "lazy-regex" or "none"');
  });

  test("rejects unknown scoped pipeline warmup modes before assembly", async () => {
    let assemblyCount = 0;
    const binding = fakeNativeBinding(PACKAGE_VERSION, {
      onAssembleStaticSearchPackageBytes: () => {
        assemblyCount += 1;
      },
    });

    const failure = await captureCreatePipelineFailure({
      binding,
      language: ["es", "sv"],
      warmup: "eager",
    });

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toHaveProperty(
      "message",
      expect.stringContaining(
        'Default native pipeline warmup must be "lazy-regex" or "none"',
      ),
    );
    expect(assemblyCount).toBe(0);
  });

  test("shared SDK helpers delegate through the native binding", () => {
    const sharedSdkFunctions: Record<
      (typeof SHARED_NATIVE_SDK_TOP_LEVEL_FUNCTIONS)[number],
      unknown
    > = {
      diagnostics_json,
      diagnostics_stream_json,
      load_prepared_package,
      load_prepared_package_file,
      native_package_version,
      normalize_for_search,
      prepare_search_package,
      redact_text,
      redact_text_json,
      redact_text_stream_json,
      summary_diagnostics_json,
    };
    for (const name of SHARED_NATIVE_SDK_TOP_LEVEL_FUNCTIONS) {
      expect(typeof sharedSdkFunctions[name]).toBe("function");
    }

    const capturedBytes: number[][] = [];
    const binding = fakeNativeBinding(PACKAGE_VERSION, {
      packageBytes: Uint8Array.of(21, 22, 23),
      onPreparedPackageBytes: (bytes) => {
        capturedBytes.push([...bytes]);
      },
    });

    expect(native_package_version({ binding })).toBe(PACKAGE_VERSION);
    expect(normalize_for_search("Číslo", { binding })).toBe("Číslo");

    const packageBytes = prepare_search_package("{}", { binding });
    expect([...packageBytes]).toEqual([21, 22, 23]);

    const prepared = load_prepared_package(packageBytes, { binding });
    expect(capturedBytes).toEqual([[21, 22, 23]]);
    expect(prepared.redact_text("x").redaction.redactedText).toBe("");
    expect(JSON.parse(prepared.warm_lazy_regex_diagnostics_json())).toEqual({
      events: [],
    });
    expect(redact_text("{}", "x", undefined, { binding }).redaction).toEqual({
      entityCount: 0,
      operatorMap: new Map(),
      redactedText: "",
      redactionMap: new Map(),
    });
    const expectedJson = {
      redaction: {
        entity_count: 0,
        operator_map: [],
        redacted_text: "",
        redaction_map: [],
      },
      resolved_entities: [],
    };
    expect(JSON.parse(prepared.redact_text_json("x"))).toEqual(expectedJson);
    expect(
      JSON.parse(redact_text_json("{}", "x", undefined, { binding })),
    ).toEqual(expectedJson);
    expect(
      JSON.parse(diagnostics_json("{}", "x", undefined, { binding })),
    ).toEqual({
      diagnostics: { events: [] },
      result: expectedJson,
    });
    const streamedBatches: unknown[] = [];
    expect(
      JSON.parse(
        diagnostics_stream_json(
          "{}",
          "x",
          (batch) => {
            streamedBatches.push(JSON.parse(batch) as unknown);
          },
          undefined,
          { binding },
        ),
      ),
    ).toEqual({
      diagnostics: { events: [] },
      result: expectedJson,
    });
    expect(streamedBatches).toEqual([{ events: [{ stage: "detect-total" }] }]);
    expect(
      JSON.parse(summary_diagnostics_json("{}", "x", undefined, { binding })),
    ).toEqual({
      diagnostics: { events: [] },
      result: expectedJson,
    });

    const dir = mkdtempSync(join(tmpdir(), "anonymize-shared-sdk-"));
    const packagePath = join(dir, "pipeline.stlanonpkg");
    try {
      writeFileSync(packagePath, packageBytes);
      const fromFile = load_prepared_package_file(packagePath, { binding });
      expect(fromFile.redact_text("x").redaction.redactedText).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("prepared anonymizers own transferable redaction sessions", () => {
    const binding = fakeNativeBinding(PACKAGE_VERSION);
    const prepared = load_prepared_package(Uint8Array.of(1), { binding });

    const session = prepared.create_redaction_session("case_1");
    expect(session.session_id()).toBe("case_1");
    expect(session.mapping_count()).toBe(0);
    expect(session.redact_text("Alice").redaction).toEqual({
      entityCount: 0,
      operatorMap: new Map(),
      redactedText: "",
      redactionMap: new Map(),
    });

    const plaintextJson = session.to_plaintext_json();
    expect(JSON.parse(plaintextJson)).toEqual({
      counters: {},
      mappings: [],
      schema_version: 1,
      session_id: "case_1",
    });
    const restored = prepared.restore_redaction_session(plaintextJson);
    expect(restored.session_id()).toBe("case_1");

    const lifecycle = prepared.createRedactionSessionWithLifecycle({
      sessionId: "case_2",
      createdAtEpochSeconds: 100,
      expiresAtEpochSeconds: 200,
    });
    expect(lifecycle.inspect(150)).toEqual({
      sessionId: "case_2",
      createdAtEpochSeconds: 100,
      expiresAtEpochSeconds: 200,
      mappingCount: 0,
      status: "active",
    });
    expect(
      lifecycle.redactTextAt({
        fullText: "Alice",
        observedAtEpochSeconds: 150,
      }).redaction.redactedText,
    ).toBe("");
    expect(JSON.parse(lifecycle.toPlaintextJsonAt(150)).schema_version).toBe(2);
    expect(lifecycle.delete()).toEqual({
      sessionId: "case_2",
      deletedMappingCount: 0,
    });
    expect(lifecycle.inspect().status).toBe("deleted");
  });

  test("prepared pipeline JSON methods use the native JSON hook", () => {
    let jsonCalls = 0;
    const binding = fakeNativeBinding(PACKAGE_VERSION, {
      onRedactStaticEntitiesJson: () => {
        jsonCalls += 1;
        return JSON.stringify({ marker: "native-json" });
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "anonymize-json-pipeline-"));
    const packagePath = join(dir, "native-pipeline.stlanonpkg");
    try {
      writeFileSync(packagePath, Uint8Array.of(1, 2, 3));
      const pipeline = createNativePipelineFromDefaultPackage({
        binding,
        packagePath,
      });

      expect(JSON.parse(pipeline.redact_text_json("x"))).toEqual({
        marker: "native-json",
      });
      expect(JSON.parse(pipeline.redactTextJson("x"))).toEqual({
        marker: "native-json",
      });
      expect(jsonCalls).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const emptyStaticRedactionBindingResult = () => ({
  resolvedEntities: [],
  redaction: {
    redactedText: "",
    redactionMap: [],
    operatorMap: [],
    entityCount: 0,
  },
});

const emptyStaticRedactionJson = (): string =>
  JSON.stringify({
    resolved_entities: [],
    redaction: {
      redacted_text: "",
      redaction_map: [],
      operator_map: [],
      entity_count: 0,
    },
  });

const emptyStaticRedactionDiagnosticJson = (): string =>
  JSON.stringify({
    diagnostics: { events: [] },
    result: {
      redaction: {
        entity_count: 0,
        operator_map: [],
        redacted_text: "",
        redaction_map: [],
      },
      resolved_entities: [],
    },
  });

type FakeNativeBindingOptions = {
  preparedSearchAsConstructor?: boolean;
  packageBytes?: Uint8Array;
  compressedPackageBytes?: Uint8Array;
  onPreparedPackageBytes?: (bytes: Uint8Array) => void;
  onPreparedPackageBytesWithoutCache?: (bytes: Uint8Array) => void;
  onTrustedPreparedPackageBytes?: (bytes: Uint8Array) => void;
  onTrustedPreparedPackageBytesWithoutCache?: (bytes: Uint8Array) => void;
  onRedactStaticEntitiesJson?: () => string;
  onDiagnosticsStreamJson?: (onBatch: NativeDiagnosticsBatchCallback) => string;
  onWarmLazyRegex?: () => void;
  onAssembleStaticSearchPackageBytes?: (configBytes: Uint8Array) => void;
};

const fakeNativeBinding = (
  version: string,
  options: FakeNativeBindingOptions = {},
): NativeAnonymizeBinding => {
  const preparedOptions = (): FakePreparedSearchOptions => ({
    ...(options.onRedactStaticEntitiesJson === undefined
      ? {}
      : { onRedactStaticEntitiesJson: options.onRedactStaticEntitiesJson }),
    ...(options.onDiagnosticsStreamJson === undefined
      ? {}
      : { onDiagnosticsStreamJson: options.onDiagnosticsStreamJson }),
    ...(options.onWarmLazyRegex === undefined
      ? {}
      : { onWarmLazyRegex: options.onWarmLazyRegex }),
  });
  const preparedSearch = {
    fromConfigJsonBytes: () => fakePreparedSearch(preparedOptions()),
    fromPreparedPackageBytes: (bytes: Uint8Array) => {
      options.onPreparedPackageBytes?.(bytes);
      return fakePreparedSearch(preparedOptions());
    },
    fromPreparedPackageBytesWithoutCache: (bytes: Uint8Array) => {
      options.onPreparedPackageBytesWithoutCache?.(bytes);
      return fakePreparedSearch(preparedOptions());
    },
    fromTrustedPreparedPackageBytesWithoutCache: (bytes: Uint8Array) => {
      options.onTrustedPreparedPackageBytesWithoutCache?.(bytes);
      return fakePreparedSearch(preparedOptions());
    },
    fromTrustedPreparedPackageBytes: (bytes: Uint8Array) => {
      options.onTrustedPreparedPackageBytes?.(bytes);
      return fakePreparedSearch(preparedOptions());
    },
  };
  const NativePreparedSearch = options.preparedSearchAsConstructor
    ? Object.assign(
        // eslint-disable-next-line eslint/prefer-arrow-callback -- constructor test doubles must be constructable
        function NativePreparedSearch() {},
        preparedSearch,
      )
    : preparedSearch;

  return {
    convertExternalDetectionBatch: () => [],
    externalDetectionLimitsJson: () => "{}",
    extractDocxTextJson: () => "{}",
    inspectPdfJson: () => "{}",
    rewritePdfRasterFromDetectionsJson: () => ({
      document: new Uint8Array(),
      certificateJson: "{}",
    }),
    rewriteDocxTextNative: () => ({
      document: new Uint8Array(),
      rewrittenBlockCount: 0,
      appliedReplacementCount: 0,
    }),
    planDocxRestorationJson: () => "{}",
    normalizeForSearch: (text: string) => text,
    nativePackageVersion: () => version,
    NativePreparedSearch,
    prepareStaticSearchPackageBytes: () =>
      options.packageBytes ?? new Uint8Array(),
    prepareStaticSearchCompressedPackageBytes: () =>
      options.compressedPackageBytes ?? new Uint8Array(),
    assembleStaticSearchConfigJson: () => new Uint8Array(),
    assembleStaticSearchPackageBytes: (configBytes) => {
      options.onAssembleStaticSearchPackageBytes?.(configBytes);
      return new Uint8Array();
    },
    assembleStaticSearchCompressedPackageBytes: () => new Uint8Array(),
  };
};

type FakePreparedSearchOptions = {
  onCallerRequestJson?: (requestJson: string) => void;
  onRedactStaticEntitiesJson?: () => string;
  onDiagnosticsStreamJson?: (onBatch: NativeDiagnosticsBatchCallback) => string;
  onWarmLazyRegex?: () => void;
};

const fakePreparedSearch = ({
  onCallerRequestJson,
  onRedactStaticEntitiesJson,
  onDiagnosticsStreamJson,
  onWarmLazyRegex,
}: FakePreparedSearchOptions): NativePreparedSearchBinding => ({
  prepareDiagnosticsJson: () => JSON.stringify({ events: [] }),
  warmLazyRegex: () => {
    onWarmLazyRegex?.();
  },
  warmLazyRegexDiagnosticsJson: () => JSON.stringify({ events: [] }),
  createRedactionSession: fakePreparedRedactionSession,
  createRedactionSessionWithLifecycle: (
    sessionId: string,
    createdAtEpochSeconds: number,
    expiresAtEpochSeconds?: number,
  ) =>
    fakePreparedRedactionSession(sessionId, {
      createdAtEpochSeconds,
      expiresAtEpochSeconds: expiresAtEpochSeconds ?? null,
    }),
  restoreRedactionSession: (plaintextJson: string) => {
    const state: {
      session_id?: unknown;
      lifecycle?: {
        created_at_epoch_seconds?: unknown;
        expires_at_epoch_seconds?: unknown;
      };
    } = JSON.parse(plaintextJson);
    if (typeof state.session_id !== "string") {
      throw new TypeError("Test session state is missing its id");
    }
    const createdAtEpochSeconds = state.lifecycle?.created_at_epoch_seconds;
    if (typeof createdAtEpochSeconds !== "number") {
      return fakePreparedRedactionSession(state.session_id);
    }
    const expiresAtEpochSeconds = state.lifecycle?.expires_at_epoch_seconds;
    return fakePreparedRedactionSession(state.session_id, {
      createdAtEpochSeconds,
      expiresAtEpochSeconds:
        typeof expiresAtEpochSeconds === "number"
          ? expiresAtEpochSeconds
          : null,
    });
  },
  restoreEncryptedRedactionSession: ({ expectedSessionId }) =>
    fakePreparedRedactionSession(expectedSessionId),
  redactStaticEntities: emptyStaticRedactionBindingResult,
  redactStaticEntitiesJson:
    onRedactStaticEntitiesJson ?? emptyStaticRedactionJson,
  redactStaticEntitiesWithCallerDetectionsJson: (
    _fullText,
    { requestJson },
  ) => {
    onCallerRequestJson?.(requestJson);
    return emptyStaticRedactionJson();
  },
  redactStaticEntitiesWithCallerDetectionsDiagnosticsJson:
    emptyStaticRedactionDiagnosticJson,
  redactStaticEntitiesResultStreamJson: (
    _fullText: string,
    _operators: unknown,
    onEvent: (eventJson: string) => void,
  ) => {
    onEvent(JSON.stringify({ type: "redacted", redaction: {} }));
    return emptyStaticRedactionJson();
  },
  redactStaticEntitiesDiagnosticsStreamJson: (
    _fullText: string,
    _operators: unknown,
    onBatch: NativeDiagnosticsBatchCallback,
  ) =>
    onDiagnosticsStreamJson?.(onBatch) ??
    (() => {
      onBatch(JSON.stringify({ events: [{ stage: "detect-total" }] }));
      return emptyStaticRedactionDiagnosticJson();
    })(),
  redactStaticEntitiesDiagnosticsJson: emptyStaticRedactionDiagnosticJson,
  redactStaticEntitiesSummaryDiagnosticsJson:
    emptyStaticRedactionDiagnosticJson,
});

const fakePreparedRedactionSession = (
  sessionId: string,
  lifecycle?: {
    createdAtEpochSeconds: number;
    expiresAtEpochSeconds: number | null;
  },
): NativePreparedRedactionSessionBinding => {
  let deleted = false;
  const redactionJson = JSON.stringify({
    resolved_entities: [],
    redaction: {
      redacted_text: "",
      redaction_map: [],
      operator_map: [],
      entity_count: 0,
    },
  });
  const plaintextJson = (): string =>
    JSON.stringify({
      schema_version: lifecycle ? 2 : 1,
      session_id: sessionId,
      ...(lifecycle
        ? {
            lifecycle: {
              created_at_epoch_seconds: lifecycle.createdAtEpochSeconds,
              expires_at_epoch_seconds: lifecycle.expiresAtEpochSeconds,
            },
          }
        : {}),
      counters: {},
      mappings: [],
    });
  const status = (observedAtEpochSeconds?: number): string => {
    if (deleted) {
      return "deleted";
    }
    if (
      lifecycle &&
      observedAtEpochSeconds !== undefined &&
      observedAtEpochSeconds < lifecycle.createdAtEpochSeconds
    ) {
      return "not_yet_active";
    }
    if (
      lifecycle?.expiresAtEpochSeconds !== null &&
      lifecycle?.expiresAtEpochSeconds !== undefined &&
      observedAtEpochSeconds !== undefined &&
      observedAtEpochSeconds >= lifecycle.expiresAtEpochSeconds
    ) {
      return "expired";
    }
    return "active";
  };
  return {
    sessionId: () => sessionId,
    mappingCount: () => 0,
    restoreText: (fullText) => fullText,
    restoreTextAt: (fullText) => fullText,
    toPlaintextJson: plaintextJson,
    toPlaintextJsonAt: plaintextJson,
    toEncryptedArchive: () => new Uint8Array(),
    toEncryptedArchiveAt: () => new Uint8Array(),
    inspectJson: (observedAtEpochSeconds?: number) =>
      JSON.stringify({
        session_id: sessionId,
        created_at_epoch_seconds: lifecycle?.createdAtEpochSeconds ?? null,
        expires_at_epoch_seconds: lifecycle?.expiresAtEpochSeconds ?? null,
        mapping_count: 0,
        status: status(observedAtEpochSeconds),
      }),
    deleteJson: () => {
      deleted = true;
      return JSON.stringify({
        session_id: sessionId,
        deleted_mapping_count: 0,
      });
    },
    redactStaticEntitiesJson: () => redactionJson,
    redactStaticEntitiesJsonAt: () => redactionJson,
    planStaticEntitiesWithCallerDetections: () => ({
      resultJson: () => "[]",
      commit: () => {},
    }),
  };
};

describe("caller detection request serialization", () => {
  test("serializes only the exact caller-detection wire shape", () => {
    let requestJson = "";
    const prepared = new PreparedNativeAnonymizer(
      fakePreparedSearch({
        onCallerRequestJson: (value) => {
          requestJson = value;
        },
      }),
    );
    const detection = Object.assign(
      {
        start: 0,
        end: 4,
        label: 'PER"SON\n😀\ud800',
        score: 1,
        providerId: "test\\provider",
        detectionId: "detection\t1",
      },
      {
        extra: "ignored",
        toJSON: () => {
          throw new Error("caller toJSON must not run");
        },
      },
    );

    prepared.redactStaticEntitiesWithCallerDetections("text", {
      detections: [detection],
    });

    expect(requestJson).toBe(
      JSON.stringify({
        version: 2,
        detections: [
          {
            start: 0,
            end: 4,
            label: 'PER"SON\n😀\ud800',
            score: 1,
            provider_id: "test\\provider",
            detection_id: "detection\t1",
          },
        ],
      }),
    );
  });

  test("bounds aggregate session JSON before reading later inputs", () => {
    class UnreadSessionInput {
      get fullText(): string {
        throw new Error("later session input was read");
      }

      get detections(): readonly NativeCallerDetection[] {
        throw new Error("later session input was read");
      }
    }

    const session = new PreparedNativeAnonymizer(
      fakePreparedSearch({}),
    ).createRedactionSession("bounded-session");
    const detection = {
      start: 0,
      end: 1,
      label: "x".repeat(11 * 1024 * 1024),
      score: 1,
      providerId: "provider",
      detectionId: "detection",
    };

    expect(() =>
      session.planTextBatchWithCallerDetections({
        inputs: [
          ...Array.from({ length: 6 }, () => ({
            fullText: "x",
            detections: [detection],
          })),
          new UnreadSessionInput(),
        ],
      }),
    ).toThrow(
      `Session caller inputs JSON exceeds the ${SESSION_CALLER_INPUTS_JSON_MAX_BYTES}-byte maximum`,
    );
  });

  test("rejects invalid numeric domains before calling the binding", () => {
    let bindingCalls = 0;
    const prepared = new PreparedNativeAnonymizer(
      fakePreparedSearch({
        onCallerRequestJson: () => {
          bindingCalls += 1;
        },
      }),
    );
    const valid: NativeCallerDetection = {
      start: 0,
      end: 1,
      label: "PERSON",
      score: 0.5,
      providerId: "test",
      detectionId: "detection-1",
    };
    const invalidCases: readonly {
      detection: NativeCallerDetection;
      message: string;
    }[] = [
      {
        detection: { ...valid, start: Number.NaN },
        message:
          "Caller detection start must be an integer between 0 and 4294967295",
      },
      {
        detection: { ...valid, end: Number.POSITIVE_INFINITY },
        message:
          "Caller detection end must be an integer between 0 and 4294967295",
      },
      {
        detection: { ...valid, start: -1 },
        message:
          "Caller detection start must be an integer between 0 and 4294967295",
      },
      {
        detection: { ...valid, end: 0.5 },
        message:
          "Caller detection end must be an integer between 0 and 4294967295",
      },
      {
        detection: { ...valid, end: 0x1_0000_0000 },
        message:
          "Caller detection end must be an integer between 0 and 4294967295",
      },
      {
        detection: { ...valid, score: Number.NaN },
        message: "Caller detection score must be finite and between 0 and 1",
      },
      {
        detection: { ...valid, score: Number.NEGATIVE_INFINITY },
        message: "Caller detection score must be finite and between 0 and 1",
      },
      {
        detection: { ...valid, score: -0.01 },
        message: "Caller detection score must be finite and between 0 and 1",
      },
      {
        detection: { ...valid, score: 1.01 },
        message: "Caller detection score must be finite and between 0 and 1",
      },
    ];

    for (const { detection, message } of invalidCases) {
      expect(() =>
        prepared.redactStaticEntitiesWithCallerDetections("x", {
          detections: [detection],
        }),
      ).toThrow(message);
    }
    expect(bindingCalls).toBe(0);
  });

  test("stops at the byte limit before reading a later hostile item", () => {
    let laterItemRead = false;
    const oversized: NativeCallerDetection = {
      start: 0,
      end: 1,
      label: "x".repeat(CALLER_DETECTION_REQUEST_JSON_MAX_BYTES),
      score: 1,
      providerId: "test",
      detectionId: "oversized",
    };
    const later: NativeCallerDetection = {
      get start(): number {
        laterItemRead = true;
        throw new Error("later item must not be read");
      },
      end: 1,
      label: "PERSON",
      score: 1,
      providerId: "test",
      detectionId: "later",
    };
    const prepared = new PreparedNativeAnonymizer(fakePreparedSearch({}));

    expect(() =>
      prepared.redactStaticEntitiesWithCallerDetections("x", {
        detections: [oversized, later],
      }),
    ).toThrow(
      `Caller detection request JSON exceeds the ${CALLER_DETECTION_REQUEST_JSON_MAX_BYTES}-byte maximum`,
    );
    expect(laterItemRead).toBe(false);
  });
});
