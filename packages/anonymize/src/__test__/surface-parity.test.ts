/**
 * Full public-surface parity contract.
 *
 * Behavioral fixture parity remains in the native SDK, Python, WASM, and DOCX
 * suites. This test closes the structural gap between those suites: every
 * public capability belongs to a named runtime profile, and every runtime in
 * that profile must expose an executable adapter for it. A new one-runtime
 * feature therefore fails here until its peer bindings land.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CAPABILITY_PARITY_PROFILES,
  CAPABILITY_SURFACES,
  type CapabilityRuntime,
  type CapabilitySurfaceId,
} from "../capabilities";
import * as native from "../native";
import * as nativeNode from "../native-node";
import * as wasm from "../wasm";

type RuntimeSurface = Record<CapabilitySurfaceId, unknown>;

const sessionPrototype = native.PreparedNativeRedactionSession?.prototype;
const preparedPrototype = native.PreparedNativeAnonymizer?.prototype;
const prototypeMethod = (
  prototype: object | undefined,
  name: string,
): unknown =>
  prototype === undefined
    ? undefined
    : Object.getOwnPropertyDescriptor(prototype, name)?.value;

const coreSurface = {
  "package.prepare": native.prepare_search_package,
  "package.load": native.load_prepared_package,
  "text.normalize": native.normalize_for_search,
  "text.redact": native.redact_text,
  "text.redact-stream": native.redact_text_stream_json,
  "text.diagnostics": native.diagnostics_json,
  "text.summary-diagnostics": native.summary_diagnostics_json,
  "text.caller-detections": prototypeMethod(
    preparedPrototype,
    "redact_text_with_caller_detections",
  ),
  "text.operators": prototypeMethod(preparedPrototype, "redact_text"),
  "package.default": nativeNode.createPipeline,
  "document.pdf.inspect":
    nativeNode.loadNativeAnonymizeBinding().inspectPdfJson,
} as const;

const nodeSurface = {
  ...coreSurface,
  "package.load-file": nativeNode.load_prepared_package_file,
  "text.external-detection-batch": nativeNode.convert_external_detection_batch,
  "session.cross-document": prototypeMethod(
    preparedPrototype,
    "createRedactionSession",
  ),
  "session.lifecycle": prototypeMethod(
    preparedPrototype,
    "createRedactionSessionWithLifecycle",
  ),
  "session.plaintext-transfer": prototypeMethod(
    sessionPrototype,
    "toPlaintextJson",
  ),
  "session.encrypted-archive": prototypeMethod(
    sessionPrototype,
    "toEncryptedArchive",
  ),
} satisfies Partial<RuntimeSurface>;

const wasmSurface = {
  "package.prepare": wasm.prepare_search_package,
  "package.load": wasm.load_prepared_package,
  "text.normalize": wasm.normalize_for_search,
  "text.redact": wasm.redact_text,
  "text.redact-stream": wasm.redact_text_stream_json,
  "text.diagnostics": wasm.diagnostics_json,
  "text.summary-diagnostics": wasm.summary_diagnostics_json,
  "text.caller-detections": prototypeMethod(
    wasm.PreparedNativeAnonymizer?.prototype,
    "redact_text_with_caller_detections",
  ),
  "text.external-detection-batch": wasm.convert_external_detection_batch,
  "text.operators": prototypeMethod(
    wasm.PreparedNativeAnonymizer?.prototype,
    "redact_text",
  ),
  "package.default": wasm.createPipeline,
  "session.cross-document": prototypeMethod(
    wasm.PreparedNativeAnonymizer?.prototype,
    "createRedactionSession",
  ),
  "session.lifecycle": prototypeMethod(
    wasm.PreparedNativeAnonymizer?.prototype,
    "createRedactionSessionWithLifecycle",
  ),
  "session.plaintext-transfer": prototypeMethod(
    wasm.PreparedNativeRedactionSession?.prototype,
    "toPlaintextJson",
  ),
  "session.encrypted-archive": prototypeMethod(
    wasm.PreparedNativeRedactionSession?.prototype,
    "toEncryptedArchive",
  ),
  "document.pdf.inspect": wasm.inspect_pdf_json,
} satisfies Partial<RuntimeSurface>;

const runtimeSurfaces = {
  node: nodeSurface,
  wasm: wasmSurface,
} as const satisfies Partial<
  Record<CapabilityRuntime, Partial<RuntimeSurface>>
>;

const invokeWasmCreatePipeline = (options: unknown) =>
  Promise.resolve(Reflect.apply(wasm.createPipeline, undefined, [options]));

const WASM_ASSET_DIR_ENV = "STLL_ANONYMIZE_ASSET_DIR";

const captureWasmCreatePipelineFailure = async (options: unknown) => {
  try {
    await invokeWasmCreatePipeline(options);
  } catch (error) {
    return error;
  }
  throw new Error("WASM createPipeline did not reject invalid options");
};

describe("full runtime surface parity", () => {
  for (const runtime of ["node", "wasm"] as const) {
    test(`${runtime} exposes every surface in its parity profiles`, () => {
      const implemented: Partial<RuntimeSurface> = runtimeSurfaces[runtime];
      const expected = CAPABILITY_SURFACES.filter(
        ({ id, profile }) =>
          (profile === "core" || !id.startsWith("document.")) &&
          CAPABILITY_PARITY_PROFILES[profile].some(
            (candidate) => candidate === runtime,
          ),
      );

      for (const { id } of expected) {
        expect(typeof implemented[id]).toBe("function");
      }
    });
  }

  test("WASM rejects injected bindings missing core PDF inspection", () =>
    expect(
      wasm.inspect_pdf_json(new Uint8Array([0]), undefined, {
        binding: {
          ...nativeNode.loadNativeAnonymizeBinding(),
          inspectPdfJson: undefined,
        } as unknown as native.NativeAnonymizeBinding,
      }),
    ).rejects.toThrow(
      "wasm binding module does not expose the native anonymize surface",
    ));

  test("WASM pipeline factory matches Node for exact language scopes", async () => {
    const nodeBinding = nativeNode.loadNativeAnonymizeBinding();
    const wasmBinding = { ...nodeBinding };
    const cases = [
      { fullText: "Adrese: Riga", language: "lv" },
      { fullText: "Adrese: Riga", language: "all" },
      {
        fullText: "Büros: Berlin und Paris.",
        language: ["de", "fr"],
      },
    ] as const;

    for (const { fullText, language } of cases) {
      const [nodePipeline, wasmPipeline] = await Promise.all([
        nativeNode.createPipeline({ binding: nodeBinding, language }),
        wasm.createPipeline({ binding: wasmBinding, language }),
      ]);
      const nodeResult = nodePipeline.redactText(fullText);
      const wasmResult = wasmPipeline.redactText(fullText);

      expect(wasmResult).toEqual(nodeResult);
      expect(wasmResult.redaction.entityCount).toBeGreaterThan(0);
    }
  });

  test("WASM treats an SPA HTML fallback as a missing package", async () => {
    const fetchBeforeTest = globalThis.fetch;
    const spaFetch = () =>
      Promise.resolve(
        new Response("<!doctype html><title>SPA</title>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      );
    spaFetch.preconnect = fetchBeforeTest.preconnect;
    globalThis.fetch = spaFetch;
    try {
      const failure = await wasm
        .loadPipeline(new URL("https://example.test/missing.stlanonpkg"), {
          binding: nativeNode.loadNativeAnonymizeBinding(),
        })
        .then(
          () => {
            throw new Error("HTML fallback did not reject");
          },
          (error: unknown) => error,
        );
      expect(failure).toHaveProperty(
        "message",
        expect.stringContaining("Prepared package is unavailable"),
      );
    } finally {
      globalThis.fetch = fetchBeforeTest;
    }
  });

  test("WASM pipeline factory rejects a corrupt exact regional package", async () => {
    const assetDirectory = await mkdtemp(
      join(tmpdir(), "anonymize-wasm-corrupt-package-"),
    );
    const previousAssetDirectory = process.env[WASM_ASSET_DIR_ENV];
    process.env[WASM_ASSET_DIR_ENV] = assetDirectory;
    await writeFile(
      join(assetDirectory, "native-pipeline.pt-br.stlanonpkg"),
      new Uint8Array([0]),
    );

    try {
      const failure = await wasm
        .createPipeline({
          binding: nativeNode.loadNativeAnonymizeBinding(),
          language: "pt-br",
        })
        .then(
          () => {
            throw new Error("corrupt exact package did not reject");
          },
          (error: unknown) => error,
        );
      expect(failure).not.toHaveProperty(
        "name",
        "PreparedPackageUnavailableError",
      );
    } finally {
      if (previousAssetDirectory === undefined) {
        Reflect.deleteProperty(process.env, WASM_ASSET_DIR_ENV);
      } else {
        process.env[WASM_ASSET_DIR_ENV] = previousAssetDirectory;
      }
      await rm(assetDirectory, { recursive: true });
    }
  });

  test("WASM pipeline factory rejects invalid language selections", async () => {
    const [unsupported, empty] = await Promise.all([
      captureWasmCreatePipelineFailure({ language: "nl" }),
      captureWasmCreatePipelineFailure({ language: [] }),
    ]);

    expect(unsupported).toHaveProperty(
      "message",
      expect.stringContaining("Unsupported pipeline language"),
    );
    expect(empty).toHaveProperty(
      "message",
      expect.stringContaining("must not be empty"),
    );
  });
});
