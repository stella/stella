---
"@stll/ai-catalog": minor
"@stll/cli": patch
---

Add `defaultTranscriptionModelId`, the cheapest transcription model offered in a region. The `dictation transcribe` capability no longer requires a model: without one the server uses that default for the organization's region.
