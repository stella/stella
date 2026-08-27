import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";

const profile = process.env.ANONYMIZE_PYTHON_WHEEL_PROFILE ?? "ci";
// When set, verify an already-built wheel (e.g. a matrix artifact produced by
// the release workflow) instead of building one here. The packlist and smoke
// assertions stay identical, so a published wheel is checked the same way the
// verify job checks a locally built one.
const prebuiltWheel = process.env.ANONYMIZE_PYTHON_WHEEL_PATH?.trim();
const nativePackagePattern =
  /^native-pipeline(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)?\.stlanonpkg$/u;
const defaultPipelineInput = "default-pipeline-input.json.gz";
const legalFiles = ["LICENSE", "NOTICE"];
const nativePackageSourceDir = join("packages", "anonymize");
const pipelineLanguageScopesSource = join(
  nativePackageSourceDir,
  "src",
  "data",
  "language-scopes.json",
);
const attributionSource = join(nativePackageSourceDir, "ATTRIBUTION.md");
const pythonNativePackageDir = join(
  "crates",
  "anonymize-py",
  "python",
  "stella_anonymize",
  "native_packages",
);
const pythonAttributionFile = join(
  "crates",
  "anonymize-py",
  "python",
  "stella_anonymize",
  "ATTRIBUTION.md",
);

if (prebuiltWheel) {
  const wheelPath = resolve(prebuiltWheel);
  if (!existsSync(wheelPath) || !wheelPath.endsWith(".whl")) {
    throw new Error(
      `prebuilt wheel does not exist or is not a .whl file: ${wheelPath}`,
    );
  }
  assertWheelContents(wheelPath);
  smokeInstalledWheel(wheelPath);
  console.log(
    JSON.stringify({
      event: "python-wheel-check",
      wheel: basename(wheelPath),
      profile: "prebuilt",
    }),
  );
} else {
  buildAndCheckWheel();
}

function buildAndCheckWheel() {
  const outDir = mkdtempSync(join(tmpdir(), "stella-anonymize-wheel-"));
  try {
    assertPythonAttributionMatchesRuntimePackage();
    syncNativePipelinePackages();
    execFileSync(
      "uvx",
      [
        "--from",
        "maturin>=1.14,<2",
        "maturin",
        "build",
        "--manifest-path",
        "crates/anonymize-py/Cargo.toml",
        "--locked",
        "--profile",
        profile,
        "--out",
        outDir,
      ],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          // Turn the build.rs native-package copy into a hard error: a wheel
          // must never ship without the bundled native pipeline packages.
          STELLA_ANONYMIZE_REQUIRE_NATIVE_PACKAGES: "1",
        },
      },
    );

    const wheel = readdirSync(outDir).find((file) => file.endsWith(".whl"));
    if (wheel === undefined) {
      throw new Error("maturin did not emit a wheel");
    }

    const wheelPath = join(outDir, wheel);
    assertWheelContents(wheelPath);
    smokeInstalledWheel(wheelPath);

    console.log(
      JSON.stringify({
        event: "python-wheel-check",
        wheel,
        profile,
      }),
    );
  } finally {
    rmSync(outDir, { force: true, recursive: true });
  }
}

function assertWheelContents(wheelPath) {
  const files = new Set(JSON.parse(readWheelFiles(wheelPath)));
  const required = [
    "stella_anonymize/__init__.py",
    "stella_anonymize/__init__.pyi",
    "stella_anonymize/docx.py",
    "stella_anonymize/pdf.py",
    "stella_anonymize/ATTRIBUTION.md",
    "stella_anonymize/_native.pyi",
    "stella_anonymize/py.typed",
    "stella_anonymize/native_packages/native-pipeline.stlanonpkg",
    "stella_anonymize/native_packages/native-pipeline.cs.stlanonpkg",
    "stella_anonymize/native_packages/native-pipeline.de.stlanonpkg",
    "stella_anonymize/native_packages/native-pipeline.en.stlanonpkg",
    "stella_anonymize/native_packages/default-pipeline-input.json.gz",
    "stella_anonymize/native_packages/pipeline-language-scopes.json",
  ];
  const missing = required.filter((file) => !files.has(file));
  if (missing.length > 0) {
    throw new Error(`wheel is missing files: ${missing.join(", ")}`);
  }
  if (![...files].some(isNativeExtension)) {
    throw new Error("wheel is missing the native _native extension");
  }
  const languageScopesEntry =
    "stella_anonymize/native_packages/pipeline-language-scopes.json";
  if (
    readWheelEntry(wheelPath, languageScopesEntry) !==
    readFileSync(pipelineLanguageScopesSource, "utf8")
  ) {
    throw new Error("wheel pipeline language scopes must match the SDK source");
  }
  for (const file of legalFiles) {
    const suffix = `.dist-info/licenses/${file}`;
    const entry = [...files].find((path) => path.endsWith(suffix));
    if (entry === undefined) {
      throw new Error(`wheel is missing ${suffix}`);
    }
    if (readWheelEntry(wheelPath, entry) !== readFileSync(file, "utf8")) {
      throw new Error(`wheel ${file} must match the repository root ${file}`);
    }
  }
}

function syncNativePipelinePackages() {
  if (!existsSync(nativePackageSourceDir)) {
    throw new Error(
      `native package source is missing: ${nativePackageSourceDir}`,
    );
  }
  mkdirSync(pythonNativePackageDir, { recursive: true });
  for (const file of readdirSync(pythonNativePackageDir)) {
    if (nativePackagePattern.test(file)) {
      rmSync(join(pythonNativePackageDir, file), { force: true });
    }
  }

  const copied = [];
  for (const file of readdirSync(nativePackageSourceDir)) {
    if (!nativePackagePattern.test(file)) {
      continue;
    }
    copyFileSync(
      join(nativePackageSourceDir, file),
      join(pythonNativePackageDir, basename(file)),
    );
    copied.push(file);
  }
  if (!copied.includes("native-pipeline.stlanonpkg")) {
    throw new Error("native-pipeline.stlanonpkg has not been built");
  }
  const defaultPipelineInputSource = join(
    nativePackageSourceDir,
    defaultPipelineInput,
  );
  if (!existsSync(defaultPipelineInputSource)) {
    throw new Error(`${defaultPipelineInput} has not been built`);
  }
  copyFileSync(
    defaultPipelineInputSource,
    join(pythonNativePackageDir, defaultPipelineInput),
  );
}

function assertPythonAttributionMatchesRuntimePackage() {
  const runtimeAttribution = readFileSync(attributionSource, "utf8");
  const pythonAttribution = readFileSync(pythonAttributionFile, "utf8");
  if (runtimeAttribution === pythonAttribution) {
    return;
  }
  throw new Error(`${pythonAttributionFile} must match ${attributionSource}`);
}

function readWheelFiles(wheelPath) {
  return execFileSync(
    "python3",
    [
      "-c",
      [
        "import json, sys, zipfile",
        "with zipfile.ZipFile(sys.argv[1]) as wheel:",
        "    print(json.dumps(wheel.namelist()))",
      ].join("\n"),
      wheelPath,
    ],
    { encoding: "utf8" },
  );
}

function readWheelEntry(wheelPath, entry) {
  return execFileSync(
    "python3",
    [
      "-c",
      [
        "import sys, zipfile",
        "with zipfile.ZipFile(sys.argv[1]) as wheel:",
        "    sys.stdout.write(wheel.read(sys.argv[2]).decode('utf-8'))",
      ].join("\n"),
      wheelPath,
      entry,
    ],
    { encoding: "utf8" },
  );
}

function smokeInstalledWheel(wheelPath) {
  execFileSync(
    "uv",
    [
      "run",
      "--isolated",
      "--no-project",
      "--python",
      "3.11",
      "--with",
      wheelPath,
      "python",
      "-c",
      [
        "import json",
        "import stella_anonymize as anonymize",
        "required = [",
        "    'PreparedAnonymizer',",
        "    'PreparedRedactionSession',",
        "    'PreparedSearch',",
        "    'available_default_native_pipeline_languages',",
        "    'anonymize_docx',",
        "    'create_pipeline',",
        "    'extract_docx_text',",
        "    'get_default_native_pipeline',",
        "    'inspect_pdf',",
        "    'load_prepared_package',",
        "    'preload_default_native_pipeline',",
        "    'prepare_search_package',",
        "    'read_default_native_pipeline_package_file',",
        "    'redact_text',",
        "    'restore_docx_text',",
        "    'rewrite_docx_text',",
        "]",
        "missing = [name for name in required if not hasattr(anonymize, name)]",
        "if missing:",
        "    raise SystemExit(f'missing exports: {missing}')",
        "available_languages = anonymize.available_default_native_pipeline_languages()",
        "if 'en' not in available_languages:",
        "    raise SystemExit(f'missing default English package: {available_languages}')",
        "config_json = json.dumps({",
        "    'regex_patterns': [{'kind': 'regex', 'pattern': r'\\b[A-Z]{2}\\d{4}\\b'}],",
        "    'slices': {'regex': {'start': 0, 'end': 1}},",
        "    'regex_meta': [{'label': 'registration number', 'score': 1.0}],",
        "})",
        "package_bytes = anonymize.prepare_search_package(config_json)",
        "prepared = anonymize.load_prepared_package(package_bytes)",
        "result = prepared.redact_text('Reference AB1234')",
        "if result.redaction.entity_count != 1:",
        "    raise SystemExit(f'unexpected entity count: {result.redaction.entity_count}')",
        "if result.redaction.redacted_text == 'Reference AB1234':",
        "    raise SystemExit('redaction did not change text')",
        "session = prepared.create_redaction_session('wheel_smoke_1')",
        "session.redact_text('Reference AB1234')",
        "session.redact_text('AB1234 appears again')",
        "if session.mapping_count() != 1:",
        "    raise SystemExit(f'session did not reuse its mapping: {session.mapping_count()}')",
        "restored_session = prepared.restore_redaction_session(session.to_plaintext_json())",
        "if restored_session.session_id() != 'wheel_smoke_1':",
        "    raise SystemExit('session did not restore its identity')",
        "archive_key = bytes([0x42]) * 32",
        "session_archive = session.to_encrypted_archive(archive_key)",
        "archive_session = prepared.restore_encrypted_redaction_session(",
        "    session_archive, archive_key, 'wheel_smoke_1'",
        ")",
        "if archive_session.mapping_count() != 1:",
        "    raise SystemExit('encrypted session archive did not preserve mappings')",
        "try:",
        "    prepared.restore_encrypted_redaction_session(",
        "        session_archive, bytes([0x43]) * 32, 'wheel_smoke_1'",
        "    )",
        "except ValueError:",
        "    pass",
        "else:",
        "    raise SystemExit('encrypted session archive accepted the wrong key')",
        "lifecycle_session = prepared.create_redaction_session_with_lifecycle(",
        "    'lifecycle_wheel_smoke_1', created_at_epoch_seconds=100, expires_at_epoch_seconds=200",
        ")",
        "lifecycle_session.redact_text_at(",
        "    'Reference AB1234', observed_at_epoch_seconds=150",
        ")",
        "lifecycle_archive = lifecycle_session.to_encrypted_archive_at(archive_key, 150)",
        "restored_lifecycle = prepared.restore_encrypted_redaction_session(",
        "    lifecycle_archive, archive_key, 'lifecycle_wheel_smoke_1',",
        "    observed_at_epoch_seconds=150,",
        ")",
        "if restored_lifecycle.inspect(150)['status'] != 'active':",
        "    raise SystemExit('encrypted lifecycle session did not restore as active')",
        "if lifecycle_session.inspect(200)['status'] != 'expired':",
        "    raise SystemExit('lifecycle session did not expire at its boundary')",
        "if lifecycle_session.delete()['deleted_mapping_count'] != 1:",
        "    raise SystemExit('lifecycle deletion did not report its mapping count')",
        "default_bytes = anonymize.read_default_native_pipeline_package_file(language='en')",
        "if len(default_bytes) == 0:",
        "    raise SystemExit('default package is empty')",
        "default_prepared = anonymize.get_default_native_pipeline(language='en')",
        "if default_prepared is not anonymize.get_default_native_pipeline(language='en'):",
        "    raise SystemExit('default package cache did not reuse prepared search')",
        "if anonymize.preload_default_native_pipeline(language='en') is not default_prepared:",
        "    raise SystemExit('preload did not return cached default package')",
        "semantic_es = anonymize.create_pipeline(language='es')",
        "if semantic_es is not anonymize.create_pipeline(language='es'):",
        "    raise SystemExit('semantic pipeline cache did not reuse exact scope')",
        "semantic_multi = anonymize.create_pipeline(language=['cs', 'en'])",
        "if semantic_multi is semantic_es:",
        "    raise SystemExit('distinct semantic scopes reused one pipeline')",
        "semantic_all = anonymize.create_pipeline(language='all')",
        "if semantic_all is not anonymize.get_default_native_pipeline():",
        "    raise SystemExit('all-language semantic pipeline missed default cache')",
        "try:",
        "    anonymize.create_pipeline(language='nl')",
        "except ValueError:",
        "    pass",
        "else:",
        "    raise SystemExit('semantic pipeline accepted an unsupported language')",
        "semantic_result = semantic_es.redact_text('Email test@example.com')",
        "if semantic_result.redaction.entity_count != 1:",
        "    raise SystemExit('semantic pipeline did not redact the email fixture')",
        "if anonymize.__version__ != anonymize.native_package_version():",
        "    raise SystemExit('module version did not match native version')",
        "print(json.dumps({",
        "    'event': 'python-wheel-import-smoke',",
        "    'version': anonymize.__version__,",
        "    'entity_count': result.redaction.entity_count,",
        "}))",
      ].join("\n"),
    ],
    { stdio: "inherit" },
  );
}

function isNativeExtension(file) {
  return (
    file.startsWith("stella_anonymize/_native.") &&
    [".so", ".pyd", ".dll", ".dylib"].some((suffix) => file.endsWith(suffix))
  );
}
