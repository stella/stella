# @stll/cli

## 0.5.0

### Minor Changes

- [#1149](https://github.com/stella/stella/pull/1149) [`9873ffb`](https://github.com/stella/stella/commit/9873ffb54fb18a874da90a456f0d7e84f3a761c6) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add first-class capability metadata and routes for agent sandbox runs.

- [#1200](https://github.com/stella/stella/pull/1200) [`7e53091`](https://github.com/stella/stella/commit/7e53091060df479830961d7be7948f2bdef739c2) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add legal-list capabilities to the CLI and expose nested entity-kind condition matching.

### Patch Changes

- [#746](https://github.com/stella/stella/pull/746) [`a325d07`](https://github.com/stella/stella/commit/a325d07276fa127a7296ed2dc3daeb53dd289fbb) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose AI memory capabilities in the generated command catalog.

- [#1782](https://github.com/stella/stella/pull/1782) [`891b685`](https://github.com/stella/stella/commit/891b6856715f07a91d1b7a7ef5251276c33ba795) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Negotiate API protocol revisions and capabilities instead of coupling compatibility to the CLI package version.

- [#1802](https://github.com/stella/stella/pull/1802) [`767b1f6`](https://github.com/stella/stella/commit/767b1f6ab46d42aad69c38a45a3a1be5d304ced6) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Hide deployment-disabled Legal Lists and governed workflow commands from the generated capability catalog.

- [#1535](https://github.com/stella/stella/pull/1535) [`e481b47`](https://github.com/stella/stella/commit/e481b477b9ea185d149a32c6cab7be0c2a557f0b) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose governed matter workflow commands through the CLI capability catalog.

- [#1834](https://github.com/stella/stella/pull/1834) [`e731ce9`](https://github.com/stella/stella/commit/e731ce9cdcf411e20508d2f8b08a0829a4dd7198) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose the time-entry summary capability in the generated CLI catalog.

- [#1839](https://github.com/stella/stella/pull/1839) [`3eaa322`](https://github.com/stella/stella/commit/3eaa322e8683cb04ba1d9252cbbad2626835060c) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Generate MCP paths, scopes, and error codes from the API-owned contract.

- [#1812](https://github.com/stella/stella/pull/1812) [`93304d8`](https://github.com/stella/stella/commit/93304d8a9e682336c1a30ef5bc4176d4d0323fc8) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose actionable document-processing states and retryable ARES failures through stella MCP clients.

- [#1833](https://github.com/stella/stella/pull/1833) [`6c52d14`](https://github.com/stella/stella/commit/6c52d14c82dfecc3a2d7317daa12f86aa9ddde62) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Include canonical resource names in case-law tool metadata.

- [#1847](https://github.com/stella/stella/pull/1847) [`6c68be3`](https://github.com/stella/stella/commit/6c68be3520868948fcd2426a89d6ce9d9e893fd4) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Refresh generated capability metadata.

## 0.4.3

### Patch Changes

- [#1777](https://github.com/stella/stella/pull/1777) [`55c409f`](https://github.com/stella/stella/commit/55c409f6c273e6e8cfdcfb2af4dd6e5ae5792df5) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Keep attached-file document uploads separate from the interactive MCP App picker.

## 0.4.2

### Patch Changes

- [#1765](https://github.com/stella/stella/pull/1765) [`3b33233`](https://github.com/stella/stella/commit/3b33233800a45b55258fa7b145d19befd4a8c91d) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add the one-command document version upload workflow and run CLI MCP traffic through the official v2 client transport.

## 0.4.1

### Patch Changes

- [#1741](https://github.com/stella/stella/pull/1741) [`0f1eceb`](https://github.com/stella/stella/commit/0f1eceb55bc199fb79d58680aec793cb755854e3) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose stella product identity through the generated MCP resource registry.

## 0.4.0

### Minor Changes

- [#1585](https://github.com/stella/stella/pull/1585) [`57ca112`](https://github.com/stella/stella/commit/57ca112b14f390e433cb1c59193c00ec4a0a4e5f) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Accept and project the `title` tool annotation from fetched registries (string, capped at 64 characters); the committed registry snapshot now carries display titles for every tool.

### Patch Changes

- [#1554](https://github.com/stella/stella/pull/1554) [`693f394`](https://github.com/stella/stella/commit/693f394d9ab8294947dc0f2f50432839ad297ae4) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Describe manual OCR requests as queued for the next configured batch.

- [#1565](https://github.com/stella/stella/pull/1565) [`d5647b6`](https://github.com/stella/stella/commit/d5647b62b14c5771402a28183b80c01557504262) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Update CLI typed error handling for better-result 3 compatibility.

- [#1537](https://github.com/stella/stella/pull/1537) [`6dbe458`](https://github.com/stella/stella/commit/6dbe4589b86d6f5af385f510d7b91d782b52974e) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Bound property dependency inputs to the workspace property limit.

## 0.3.1

### Patch Changes

- [#1428](https://github.com/stella/stella/pull/1428) [`d0826dc`](https://github.com/stella/stella/commit/d0826dc95e9031c1761d8d628fd42a06fa8528e9) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose the chat message export capability in the generated catalog.

- [#1373](https://github.com/stella/stella/pull/1373) [`34d0934`](https://github.com/stella/stella/commit/34d09345259793b0837c0fec55b0e47c075ec408) Thanks [@Pallavikumarimdb](https://github.com/Pallavikumarimdb)! - Expose the clause export format selector in the generated capability catalog.

- [#1464](https://github.com/stella/stella/pull/1464) [`2f3ccb4`](https://github.com/stella/stella/commit/2f3ccb4e6e72705a54d05503a4e33b80c0103d09) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose the organization document-processing mode in the generated capability catalog.

- [#1512](https://github.com/stella/stella/pull/1512) [`2cba1a6`](https://github.com/stella/stella/commit/2cba1a6ddcaacb1c464f4d90af1cd89f63d5fbc3) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Keep generated CLI version metadata synchronized during automated releases.

- [#1450](https://github.com/stella/stella/pull/1450) [`a5c2783`](https://github.com/stella/stella/commit/a5c27833a87a334b5258c1c8d2f682ed3d4d708d) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose repository skill discovery and import through the generated capability catalog.

- [#1501](https://github.com/stella/stella/pull/1501) [`9b91c0c`](https://github.com/stella/stella/commit/9b91c0cf0203a6c56219f3f8ff7f17527c9127ae) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add commands for saving a filled template as a new document or document version.

## 0.3.0

- Normalized capability action names and updated the CLI/API compatibility contract.
