# Admitting a model run under its organization's caps

Generated from `scripts/ownership/model-run-cap-admission.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                                      | Owner                                    | Enforcement                      | Summary             |
| ------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------- | ------------------- |
| `model-run-cap-admission` — Admitting a model run under its organization's caps | `apps/api/src/lib/usage/model-run-caps/` | literal pattern `app\.model_run_ | model_run_(?:active | daily)_cap` (plus 1 allowed file) | A run starts under its kind's caps only through `startModelRun`, which hands the insert trigger the configured limits and turns the trigger's refusal into the shared typed error. The limit settings and the refusal constraints are named nowhere else. |
