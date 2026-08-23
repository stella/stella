export type BenchmarkTask =
  | "span-redaction"
  | "contextual-redaction"
  | "named-entity-recognition";

export type BenchmarkAccess = "bundled-development" | "verified-download";

export type BenchmarkPolicy = "development" | "evaluation-only";

export type BenchmarkCorpus = {
  readonly id: string;
  readonly name: string;
  readonly domains: readonly string[];
  readonly languages: readonly string[];
  readonly task: BenchmarkTask;
  readonly access: BenchmarkAccess;
  readonly policy: BenchmarkPolicy;
  readonly license: string;
  readonly source: string;
  readonly version: string;
  readonly artifact?: {
    readonly file: string;
    readonly sha256: string;
    readonly split: "dev" | "test" | "evaluation";
  };
  readonly runnable: boolean;
  readonly execution?: {
    readonly script: string;
    readonly args: readonly string[];
  };
  readonly notes: string;
};

export const BENCHMARK_CORPORA: readonly BenchmarkCorpus[] = [
  {
    id: "stella-synthetic-legal",
    name: "stella synthetic legal fixtures",
    domains: ["contracts"],
    languages: ["cs", "de", "en"],
    task: "span-redaction",
    access: "bundled-development",
    policy: "development",
    license: "Apache-2.0",
    source: "packages/benchmark/fixtures",
    version: "repository",
    runnable: true,
    notes: "Public development fixtures; permitted for detector iteration.",
  },
  {
    id: "tab-echr-development",
    name: "Text Anonymization Benchmark (TAB) development split",
    domains: ["court decisions", "legal"],
    languages: ["en"],
    task: "span-redaction",
    access: "verified-download",
    policy: "development",
    license: "MIT",
    source: TAB_DEV_PROVENANCE.repository,
    version: TAB_DEV_PROVENANCE.commit,
    artifact: {
      file: TAB_DEV_PROVENANCE.file,
      sha256: TAB_DEV_PROVENANCE.sha256,
      split: "dev",
    },
    runnable: true,
    notes:
      "Declared TAB development split; deterministic five-document diagnostics may guide detector iteration.",
  },
  {
    id: "tab-echr",
    name: "Text Anonymization Benchmark (TAB)",
    domains: ["court decisions", "legal"],
    languages: ["en"],
    task: "span-redaction",
    access: "verified-download",
    policy: "evaluation-only",
    license: "MIT",
    source: TAB_PROVENANCE.repository,
    version: TAB_PROVENANCE.commit,
    artifact: {
      file: TAB_PROVENANCE.file,
      sha256: TAB_PROVENANCE.sha256,
      split: "test",
    },
    runnable: true,
    execution: { script: "blind.ts", args: ["--full"] },
    notes: "Independent annotator judgments; aggregate-only sealed reports.",
  },
  {
    id: "redactionbench",
    name: "RedactionBench",
    domains: [
      "contracts",
      "legal",
      "medical",
      "financial",
      "government",
      "email",
      "code",
      "files",
      "logs",
      "terminal",
    ],
    languages: ["en"],
    task: "contextual-redaction",
    access: "verified-download",
    policy: "evaluation-only",
    license: "CC-BY-4.0",
    source: REDACTIONBENCH_PROVENANCE.repository,
    version: REDACTIONBENCH_PROVENANCE.commit,
    artifact: {
      file: REDACTIONBENCH_PROVENANCE.file,
      sha256: REDACTIONBENCH_PROVENANCE.sha256,
      split: "test",
    },
    runnable: true,
    execution: { script: "redactionbench.ts", args: [] },
    notes:
      "Mandatory/contextual spans. Reports transparent interim metrics until the official R-Score implementation is published.",
  },
  {
    id: "meddocan",
    name: "MEDDOCAN",
    domains: ["medical"],
    languages: ["es"],
    task: "span-redaction",
    access: "verified-download",
    policy: "evaluation-only",
    license: "CC-BY-4.0",
    source: MEDDOCAN_PROVENANCE.repository,
    version: MEDDOCAN_PROVENANCE.version,
    artifact: {
      file: MEDDOCAN_PROVENANCE.file,
      sha256: MEDDOCAN_PROVENANCE.sha256,
      split: "test",
    },
    runnable: true,
    execution: { script: "meddocan.ts", args: [] },
    notes:
      "Complete 250-document test split; checksum-pinned Zenodo BRAT archive.",
  },
  {
    id: "multigrassco",
    name: "MultiGraSCCo",
    domains: ["medical"],
    languages: ["ar", "de", "en", "fa", "fr", "it", "pl", "ru", "tr", "uk"],
    task: "contextual-redaction",
    access: "verified-download",
    policy: "evaluation-only",
    license: MULTIGRASCCO_PROVENANCE.license,
    source: MULTIGRASCCO_PROVENANCE.repository,
    version: MULTIGRASCCO_PROVENANCE.version,
    artifact: {
      file: MULTIGRASCCO_PROVENANCE.file,
      sha256: MULTIGRASCCO_PROVENANCE.sha256,
      split: "evaluation",
    },
    runnable: true,
    execution: { script: "multigrassco.ts", args: [] },
    notes:
      "Multilingual synthetic clinical corpus with separate direct (PHI) and indirect (IPI) annotations; documents with invalid source spans are excluded by a declared integrity rule.",
  },
  {
    id: "german-ler",
    name: "German Legal Entity Recognition",
    domains: ["court decisions", "legal"],
    languages: ["de"],
    task: "named-entity-recognition",
    access: "verified-download",
    policy: "evaluation-only",
    license: GERMAN_LER_PROVENANCE.license,
    source: GERMAN_LER_PROVENANCE.repository,
    version: GERMAN_LER_PROVENANCE.commit,
    artifact: {
      file: GERMAN_LER_PROVENANCE.file,
      sha256: GERMAN_LER_PROVENANCE.sha256,
      split: "test",
    },
    runnable: true,
    execution: { script: "german-ler.ts", args: [] },
    notes:
      "All 6,673 public test sentences. Label-agnostic entity coverage is a legal NER diagnostic, not PII recall or label-aware NER accuracy.",
  },
] as const;

export const validateBenchmarkRegistry = (): void => {
  const ids = new Set<string>();
  for (const corpus of BENCHMARK_CORPORA) {
    if (ids.has(corpus.id)) {
      throw new Error(`duplicate benchmark corpus id ${corpus.id}`);
    }
    ids.add(corpus.id);
    if (corpus.policy !== "development" && corpus.version.trim() === "") {
      throw new Error(`${corpus.id} must pin a source version`);
    }
    if (corpus.access === "verified-download") {
      if (corpus.artifact === undefined) {
        throw new Error(`${corpus.id} must pin a downloadable artifact`);
      }
      if (!/^[a-f0-9]{64}$/u.test(corpus.artifact.sha256)) {
        throw new Error(`${corpus.id} must pin a valid SHA-256 digest`);
      }
      const validSplit =
        corpus.policy === "evaluation-only"
          ? corpus.artifact.split === "test" ||
            corpus.artifact.split === "evaluation"
          : corpus.artifact.split === "dev";
      if (!validSplit) {
        throw new Error(`${corpus.id} artifact split violates its policy`);
      }
    }
    if (
      corpus.runnable &&
      corpus.policy === "evaluation-only" &&
      corpus.execution === undefined
    ) {
      throw new Error(`${corpus.id} must declare sealed-suite execution`);
    }
  }
};
import { TAB_DEV_PROVENANCE, TAB_PROVENANCE } from "../blind/tab";
import { GERMAN_LER_PROVENANCE } from "./german-ler";
import { MEDDOCAN_PROVENANCE } from "./meddocan";
import { MULTIGRASCCO_PROVENANCE } from "./multigrassco";
import { REDACTIONBENCH_PROVENANCE } from "./redactionbench";
