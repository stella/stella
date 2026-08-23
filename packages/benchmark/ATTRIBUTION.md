# Public evaluation corpus attribution

The sealed runners download public test artifacts at the pinned versions and
verify the listed SHA-256 digest before parsing. Corpus files are not
redistributed by this repository.

## Text Anonymization Benchmark (TAB)

- Project: Text Anonymization Benchmark
- Source: https://github.com/NorskRegnesentral/text-anonymization-benchmark
- Commit: `558e09e26d6b36f5f78440074e6a233946d98bd9`
- Test artifact: `echr_test.json`
- SHA-256: `cd0f0f15f84a8739654c7cf30c6be8ce27b051ef73974d39d792a0cb8c846379`
- License: MIT

## RedactionBench

- Project: RedactionBench
- Source: https://huggingface.co/datasets/RedactionBench/RedactionBench
- Commit: `d45e9cec89bc49c69355e252fec29cc0229982f6`
- Test artifact: `data/test-00000-of-00001.parquet`
- SHA-256: `17ea0b577344917ce6e265667dd833cbf18e4f2cc07aa230d55f1e151219f5f0`
- License: Creative Commons Attribution 4.0 International (CC BY 4.0)

## MEDDOCAN

- Project: MEDDOCAN
- DOI: https://doi.org/10.5281/zenodo.4279323
- Record: https://zenodo.org/records/4279323
- Test archive: `meddocan.zip`
- SHA-256: `d0e4708b58689bc1440ede6f89e017e58d667827d927827622d73810cd68eac3`
- License: Creative Commons Attribution 4.0 International (CC BY 4.0)

## German Legal Entity Recognition

- Project: German Named Entity Recognition in Legal Documents
- Source: https://huggingface.co/datasets/elenanereiss/german-ler
- Commit: `405b6923dfd2299da3d76a68220ee15a95bc1eab`
- Test artifact: `data/test-00000-of-00001.parquet`
- SHA-256: `78e36e4c297e95d755e2a80c8a98f988efee23c2f27e3dfb8c6c28872a57a7e6`
- License: Creative Commons Attribution 4.0 International (CC BY 4.0)
- Paper: https://arxiv.org/abs/2003.13016
- Citation: Elena Leitner, Georg Rehm, and Julian Moreno-Schneider,
  “Fine-grained Named Entity Recognition in Legal Documents” (2019)

## MultiGraSCCo

- Project: MultiGraSCCo, a multilingual Graz synthetic clinical corpus
- DOI: https://doi.org/10.5281/zenodo.18847836
- Record: https://zenodo.org/records/18847836
- Evaluation archive: `MultiGraSCCo_annotations.zip`
- SHA-256: `bfbd84d32a39dd53b0f63e0a3b49e423feb0188c686497ac7b9e62366cbb95ff`
- License: Creative Commons Attribution 4.0 International (CC BY 4.0)

The published archive contains invalid annotations in 25 translated documents,
including stale offsets and one empty span. The runner excludes an entire
document when any direct or indirect annotation fails exact text/offset
validation; it never reconstructs spans from the annotated entity text. The
aggregate report records both source and excluded document counts.

Use of each corpus remains subject to its upstream license and citation
requirements. See the linked upstream project or record for the canonical
license text and citation metadata.

## Benchmark provider dependencies

### OpenRedaction

OpenRedaction is invoked as a pinned benchmark dependency; its source is not
redistributed here.

- Project: OpenRedaction
- Source: https://github.com/sam247/openredaction
- Version: `@openredaction/core` 1.1.5
- Published source commit: `3c11cf570ae4f9e6206a5f8321e8fb8d60cb9c04`
- License: MIT (see the upstream repository for the canonical license text)
- Configuration: stateless local regex engine; learning and optional NER disabled

### Nym PII multilingual small

The opt-in German assisted lane downloads the reviewed `int8/` ONNX export;
the model and its training data are not redistributed by this repository. The
native Rust adapter's token-classification, windowing, and BIO-decoding
structure is derived from the upstream implementation named below.

- Model: https://huggingface.co/Wismut/nym-pii-multilingual-small
- Model revision: `4348999cd3c2e20c49615e9af7c6bbb45b64cd85`
- Model subfolder: `int8/`
- Exact artifact sizes and SHA-256 digests: `native/nym-adapter/model-manifest.json`
- Source: https://github.com/byteowlz/nym
- Source commit reviewed: `56f6dac6454edb6349e60a8366047577ab10b4f5`
- License: MIT

### DataFog

DataFog is invoked as an external, pinned benchmark dependency; its source is
not redistributed here.

- Project: DataFog Python
- Source: https://github.com/DataFog/datafog-python
- Version: `4.8.0`
- Release: https://github.com/DataFog/datafog-python/releases/tag/v4.8.0
- License: MIT (see the upstream repository for the canonical license text)
- Configuration: core `regex` engine only; optional spaCy and GLiNER engines
  are not installed or invoked
