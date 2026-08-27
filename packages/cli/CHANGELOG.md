# @stll/anonymize-cli

## 2.9.0

### Patch Changes

- Updated dependencies [[`21cc2c5`](https://github.com/stella/anonymize/commit/21cc2c594e68b7a6a22f9c82330fea8dd6f28b8f)]:
  - @stll/anonymize@2.9.0
  - @stll/anonymize-pdf@2.9.0
  - @stll/anonymize-docx@2.9.0

## 2.8.3

### Patch Changes

- Updated dependencies [[`6adf841`](https://github.com/stella/anonymize/commit/6adf841c8e90be759f9a0ea63f97d49e9da2d935)]:
  - @stll/anonymize@2.8.3
  - @stll/anonymize-docx@2.8.3
  - @stll/anonymize-pdf@2.8.3

## 2.8.2

### Patch Changes

- Updated dependencies [[`de387c5`](https://github.com/stella/anonymize/commit/de387c598d97eca428f510a64ebe6aaa8d398db9)]:
  - @stll/anonymize@2.8.2
  - @stll/anonymize-pdf@2.8.2
  - @stll/anonymize-docx@2.8.2

## 2.8.1

### Patch Changes

- Updated dependencies [[`1dc18b9`](https://github.com/stella/anonymize/commit/1dc18b973f9389483f479f6dcacf052189af56d4), [`e0edb97`](https://github.com/stella/anonymize/commit/e0edb973712214e149e9515a1c643185b5c07837)]:
  - @stll/anonymize@2.8.1
  - @stll/anonymize-pdf@2.8.1
  - @stll/anonymize-docx@2.8.1

## 2.8.0

### Patch Changes

- [#457](https://github.com/stella/anonymize/pull/457) [`40a3bff`](https://github.com/stella/anonymize/commit/40a3bff127df2016b7a05cd16949ef2bd127b542) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Publish reversible CLI key files with owner-only permissions on Linux and fail
  closed on platforms where filesystem ACLs cannot be verified.

- [#460](https://github.com/stella/anonymize/pull/460) [`c634939`](https://github.com/stella/anonymize/commit/c6349393e77438f99a18e81c8c27de3a329b3316) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Require Bun 1.4 or newer, use its native N-API binding, and stop installing the
  browser WASM runtime with Node.js and Bun packages.
- Updated dependencies [[`aa921dc`](https://github.com/stella/anonymize/commit/aa921dcbc29c97d30b8bee8ea1904c4baf89949a), [`40a3bff`](https://github.com/stella/anonymize/commit/40a3bff127df2016b7a05cd16949ef2bd127b542), [`c634939`](https://github.com/stella/anonymize/commit/c6349393e77438f99a18e81c8c27de3a329b3316)]:
  - @stll/anonymize@2.8.0
  - @stll/anonymize-pdf@2.8.0
  - @stll/anonymize-docx@2.8.0

## 2.7.8

### Patch Changes

- Updated dependencies [[`b184ff7`](https://github.com/stella/anonymize/commit/b184ff77269a3831af4537713f33f2f1a0c97156)]:
  - @stll/anonymize@2.7.8
  - @stll/anonymize-pdf@2.7.8
  - @stll/anonymize-docx@2.7.8

## 2.7.7

### Patch Changes

- Updated dependencies [[`7813b99`](https://github.com/stella/anonymize/commit/7813b9928aeec0cf79f8da0acabad39388264919)]:
  - @stll/anonymize@2.7.7
  - @stll/anonymize-pdf@2.7.7
  - @stll/anonymize-docx@2.7.7

## 2.7.6

### Patch Changes

- Updated dependencies []:
  - @stll/anonymize@2.7.6
  - @stll/anonymize-pdf@2.7.6
  - @stll/anonymize-docx@2.7.6

## 2.7.5

### Patch Changes

- Updated dependencies [[`c0b4bcf`](https://github.com/stella/anonymize/commit/c0b4bcf140f4edb15797d1928d727dc5ce3a2b3f)]:
  - @stll/anonymize@2.7.5
  - @stll/anonymize-pdf@2.7.5
  - @stll/anonymize-docx@2.7.5

## 2.7.4

### Patch Changes

- Updated dependencies [[`179ddf7`](https://github.com/stella/anonymize/commit/179ddf783fd927d4396171bc1db5d03c63df19be)]:
  - @stll/anonymize@2.7.4
  - @stll/anonymize-pdf@2.7.4
  - @stll/anonymize-docx@2.7.4

## 2.7.3

### Patch Changes

- Updated dependencies [[`8d4526e`](https://github.com/stella/anonymize/commit/8d4526e1c2bc0a485b713cb107683755a128ce05)]:
  - @stll/anonymize@2.7.3
  - @stll/anonymize-pdf@2.7.3
  - @stll/anonymize-docx@2.7.3

## 2.7.2

### Patch Changes

- Updated dependencies [[`158416a`](https://github.com/stella/anonymize/commit/158416a22f787f157e02976548c0dbbfef2b66b4)]:
  - @stll/anonymize@2.7.2
  - @stll/anonymize-docx@2.7.2
  - @stll/anonymize-pdf@2.7.2

## 2.7.1

### Patch Changes

- [#427](https://github.com/stella/anonymize/pull/427) [`a4ac8c5`](https://github.com/stella/anonymize/commit/a4ac8c57d606c55a79951147772e4fafb39071f9) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Require `@stll/anonymize-data` 0.0.9, which moves the city API to a `./cities`
  subpath. The city loader map holds one literal `import()` per covered country,
  so bundling anything from the data package root emitted all 237 city chunks
  (~815 KiB) even for a consumer that only loaded name dictionaries.
- Updated dependencies [[`a4ac8c5`](https://github.com/stella/anonymize/commit/a4ac8c57d606c55a79951147772e4fafb39071f9), [`32da9d3`](https://github.com/stella/anonymize/commit/32da9d38100aef12f9eb7fb105644dd7731376cb)]:
  - @stll/anonymize@2.7.1
  - @stll/anonymize-pdf@2.7.1
  - @stll/anonymize-docx@2.7.1

## 2.7.0

### Patch Changes

- [#423](https://github.com/stella/anonymize/pull/423) [`def8bc9`](https://github.com/stella/anonymize/commit/def8bc901a659426df257079f987ccc2f75ef4b4) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Require `@stll/anonymize-data` 0.0.8, whose city dictionaries load through
  literal `import()` specifiers. The previous computed specifier was invisible
  to bundlers, so bundled consumers silently received empty city lists and
  under-redacted places.
- Updated dependencies [[`6e0d1e1`](https://github.com/stella/anonymize/commit/6e0d1e16f678af15f61d708eee0a2465ff8199fd), [`def8bc9`](https://github.com/stella/anonymize/commit/def8bc901a659426df257079f987ccc2f75ef4b4), [`6e0d1e1`](https://github.com/stella/anonymize/commit/6e0d1e16f678af15f61d708eee0a2465ff8199fd)]:
  - @stll/anonymize@2.7.0
  - @stll/anonymize-pdf@2.7.0
  - @stll/anonymize-docx@2.7.0

## 2.6.3

### Patch Changes

- Updated dependencies [[`d3363c3`](https://github.com/stella/anonymize/commit/d3363c3e7d4a09a922778b0189866e1d745638aa), [`90b3834`](https://github.com/stella/anonymize/commit/90b3834436c92925ab717ee827d681036e0420ab), [`68672ea`](https://github.com/stella/anonymize/commit/68672eacc8bc6dc89c285ec5a3fe360336b65296), [`b561bac`](https://github.com/stella/anonymize/commit/b561bac2edc4e9e0205e1958fc826e42d7183d6b)]:
  - @stll/anonymize@2.6.3
  - @stll/anonymize-pdf@2.6.3
  - @stll/anonymize-docx@2.6.3

## 2.6.2

### Patch Changes

- Updated dependencies [[`d77a69b`](https://github.com/stella/anonymize/commit/d77a69b5d4b97105cff3fe1fde1d00201dda8102)]:
  - @stll/anonymize@2.6.2
  - @stll/anonymize-pdf@2.6.2
  - @stll/anonymize-docx@2.6.2

## 2.6.1

### Patch Changes

- Updated dependencies [[`deb2d7c`](https://github.com/stella/anonymize/commit/deb2d7c3c2dd346589478fd8191bea088a1563b7)]:
  - @stll/anonymize@2.6.1
  - @stll/anonymize-pdf@2.6.1
  - @stll/anonymize-docx@2.6.1

## 2.6.0

### Patch Changes

- Updated dependencies []:
  - @stll/anonymize@2.6.0
  - @stll/anonymize-pdf@2.6.0
  - @stll/anonymize-docx@2.6.0

## 2.5.0

### Minor Changes

- [#398](https://github.com/stella/anonymize/pull/398) [`2414231`](https://github.com/stella/anonymize/commit/2414231ba7f016787c10ca66fd6b40b71a10d251) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add an agent-native CLI/MCP surface and Bun runtime support.

  - Structured tool-error envelope `{error:{code,message,hint,retryable}}` across the
    MCP, a distinct CLI exit code per code, budgeted `initialize` instructions, and a
    local, offline `send_feedback` tool / `anonymize feedback` command that sanitizes
    the text and returns a prefilled GitHub issue URL the human submits (no network
    call). anonymize has no destructive tools, so there is no confirm gate.
  - Run the native pipeline under Bun via the `@stll/anonymize-wasm` binding, exposed
    through `@stll/anonymize/native-runtime` (`preloadNativeBinding`): the NAPI addon
    calls `uv_get_osfhandle`, which Bun does not implement, so under Bun the wasm
    binding is installed as the loader backend. A no-op on Node.

### Patch Changes

- Updated dependencies [[`2414231`](https://github.com/stella/anonymize/commit/2414231ba7f016787c10ca66fd6b40b71a10d251), [`83d58ef`](https://github.com/stella/anonymize/commit/83d58efecb0e8f0ef9161bc7568d8c397b5072ab)]:
  - @stll/anonymize@2.5.0
  - @stll/anonymize-pdf@2.5.0
  - @stll/anonymize-docx@2.5.0

## 2.4.2

### Patch Changes

- [#396](https://github.com/stella/anonymize/pull/396) [`e1ca10d`](https://github.com/stella/anonymize/commit/e1ca10d4260fb4911fedfa921d0cc96687803449) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Require the independently versioned data package that contains the language
  and clinical data shipped with this release.
- Updated dependencies [[`e019d1d`](https://github.com/stella/anonymize/commit/e019d1dee10a76660fd7cf041dfffe165acc1c24), [`458db0a`](https://github.com/stella/anonymize/commit/458db0a9c9b4eaa778af93be4e453c8057365f24), [`8bb15b6`](https://github.com/stella/anonymize/commit/8bb15b632af0c045fdfd87559e9a330fa802cad1), [`9ed1c05`](https://github.com/stella/anonymize/commit/9ed1c05d6cfb06ef66d7a6be4ed7935a4fa87fca), [`3073898`](https://github.com/stella/anonymize/commit/3073898db52a5b178efac30cffc37875f3b81b13), [`9821929`](https://github.com/stella/anonymize/commit/982192969e618a49ea5989ce6961ce68d33e89f2), [`e1ca10d`](https://github.com/stella/anonymize/commit/e1ca10d4260fb4911fedfa921d0cc96687803449), [`ae46b72`](https://github.com/stella/anonymize/commit/ae46b720c37dd7b5c84fbe419971ff3b7df8db0e), [`aaff4d7`](https://github.com/stella/anonymize/commit/aaff4d7e369eb3b76f420a648f53a7a698011d11), [`a66cd04`](https://github.com/stella/anonymize/commit/a66cd04e2fd0af5ab6c54cac0bbf6efd03edc492), [`d937fd6`](https://github.com/stella/anonymize/commit/d937fd67b08a3ee73e4af7e67c656c95edeb6af4), [`b8adef9`](https://github.com/stella/anonymize/commit/b8adef93d03260f736f5e642bacbfbcf7842fd3b), [`cced835`](https://github.com/stella/anonymize/commit/cced8358593a4381d7323a26ad7bad99547b69af)]:
  - @stll/anonymize@2.4.2
  - @stll/anonymize-pdf@2.4.2
  - @stll/anonymize-docx@2.4.2

## 2.4.1

### Patch Changes

- Updated dependencies [[`6469935`](https://github.com/stella/anonymize/commit/64699354e210eed7eadaa2650d06fd195942c5c6), [`20071a8`](https://github.com/stella/anonymize/commit/20071a8a8d0841cb1c7bf1a7dd41f183966f0ab3), [`bf1eda3`](https://github.com/stella/anonymize/commit/bf1eda396973bc04986c75cb6b5ec63214e24799), [`3e95d22`](https://github.com/stella/anonymize/commit/3e95d22a8768539b539fdbb39df6e1e5d4d8e88f), [`4f5140f`](https://github.com/stella/anonymize/commit/4f5140fbaddbb69aafa68dec98bd06c4b2b7a45e), [`bf1eda3`](https://github.com/stella/anonymize/commit/bf1eda396973bc04986c75cb6b5ec63214e24799), [`4f5140f`](https://github.com/stella/anonymize/commit/4f5140fbaddbb69aafa68dec98bd06c4b2b7a45e)]:
  - @stll/anonymize@2.4.1
  - @stll/anonymize-pdf@2.4.1
  - @stll/anonymize-docx@2.4.1

## 2.4.0

### Minor Changes

- [#344](https://github.com/stella/anonymize/pull/344) [`66b250b`](https://github.com/stella/anonymize/commit/66b250bb4d633715402784210428341047c73816) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add a bounded local Poppler/Tesseract PDF observation adapter and an atomic,
  non-overwriting CLI workflow for verified destructive image-only output. OCR
  uses one explicit language pack and the certificate remains honest about recall.

### Patch Changes

- Updated dependencies [[`a8ffd9b`](https://github.com/stella/anonymize/commit/a8ffd9be1ad3115ae0f405d5eb0880589377a98a), [`6b547a1`](https://github.com/stella/anonymize/commit/6b547a1e675ba5219d3a97de7d2a6b5213ebad7c), [`ac27bc1`](https://github.com/stella/anonymize/commit/ac27bc1b620d847daadcd8559919258867c7e8bb), [`66b250b`](https://github.com/stella/anonymize/commit/66b250bb4d633715402784210428341047c73816), [`3923dbe`](https://github.com/stella/anonymize/commit/3923dbe6d0b1fe202e1a3a23a54166aee5885d64), [`ed699d9`](https://github.com/stella/anonymize/commit/ed699d932ce40c5ca5749b6235146b713eba78b6), [`97cdfff`](https://github.com/stella/anonymize/commit/97cdfff8cf42851e2f7d5d1b866cfadfaaa5dbc0), [`41f440c`](https://github.com/stella/anonymize/commit/41f440c19ab7b8cebe59f4cbb2c2dcda47b4dd67), [`db7c4d1`](https://github.com/stella/anonymize/commit/db7c4d1908750585e4e294e380cb826a36b48375), [`984c7bb`](https://github.com/stella/anonymize/commit/984c7bb6b8d2c8ec7855af67b104bd8c2e4b0b38)]:
  - @stll/anonymize@2.4.0
  - @stll/anonymize-pdf@2.4.0
  - @stll/anonymize-docx@2.4.0

## 2.3.0

### Patch Changes

- [#321](https://github.com/stella/anonymize/pull/321) [`1d5a1d0`](https://github.com/stella/anonymize/commit/1d5a1d0e8f4d9d89be949e1074cd3e407ccc5c41) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Detect day-month dates without a year while rejecting invalid calendar days
  and keeping lowercase month ambiguities scoped to their language vocabulary.
- Updated dependencies [[`1d5a1d0`](https://github.com/stella/anonymize/commit/1d5a1d0e8f4d9d89be949e1074cd3e407ccc5c41), [`f74669b`](https://github.com/stella/anonymize/commit/f74669ba7ca7611d22baaafd71251e8bb39c734b), [`d8d415b`](https://github.com/stella/anonymize/commit/d8d415b73081aac38ca5d3b190a237e372d3a557), [`6ae6b7b`](https://github.com/stella/anonymize/commit/6ae6b7bf6107d221e2d00e6ab9bddd464637920d), [`dab5a5d`](https://github.com/stella/anonymize/commit/dab5a5d0b2855e0684ceac8d0d70e5ebc5ac234f), [`9683503`](https://github.com/stella/anonymize/commit/96835036dd4c47d246d4237d9e7476c9d58b9e2a), [`b4d8986`](https://github.com/stella/anonymize/commit/b4d89868988c467d20e6d5f5a860235e04464a95), [`4016556`](https://github.com/stella/anonymize/commit/4016556b0d63d3e534722ac2e8e8eb1023a6cd1a), [`2b205ad`](https://github.com/stella/anonymize/commit/2b205adcc78721340aa233fb9d259c614a908e2c), [`315b963`](https://github.com/stella/anonymize/commit/315b963107fd6da567d14beac69b85f0575e9a0a), [`431611c`](https://github.com/stella/anonymize/commit/431611c978e8c8ac425357af1a42d4534e46f7c7)]:
  - @stll/anonymize@2.3.0
  - @stll/anonymize-docx@2.3.0

## 2.2.0

### Minor Changes

- [#293](https://github.com/stella/anonymize/pull/293) [`32807bb`](https://github.com/stella/anonymize/commit/32807bb416854e5dce169e2f2cacd9237ed5f4ce) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Remove the deprecated `PipelineConfig.enableNer` field. The native pipeline never implemented NER and always rejected `true`; typed callers that still pass `enableNer: false` should delete the line. Untyped callers that pass `enableNer: true` keep failing fast through `assertNativePipelineSupported`. Configs serialized with the old field (existing prepared packages) continue to load; the stale key is ignored.

### Patch Changes

- Updated dependencies [[`eeef356`](https://github.com/stella/anonymize/commit/eeef356715307cda6c0c5e425c5fc9f3e0a317bb), [`39f4deb`](https://github.com/stella/anonymize/commit/39f4deb5f6011d8953585ff3656c53058dc13f73), [`9f53741`](https://github.com/stella/anonymize/commit/9f53741e4ca9d847097fa342fecb2693b6e3a091), [`d6a8fd9`](https://github.com/stella/anonymize/commit/d6a8fd9fa2d096423afbcd7e0f558bfee17840bb), [`33c533a`](https://github.com/stella/anonymize/commit/33c533a60a4937213e557aec05c37d11f4d78731), [`956d098`](https://github.com/stella/anonymize/commit/956d0989dcd51fd7a45c36076813392112a6bfb6), [`32807bb`](https://github.com/stella/anonymize/commit/32807bb416854e5dce169e2f2cacd9237ed5f4ce), [`b90de58`](https://github.com/stella/anonymize/commit/b90de58df6d09cec68d72ce810b2dd07fe5a5694), [`b90de58`](https://github.com/stella/anonymize/commit/b90de58df6d09cec68d72ce810b2dd07fe5a5694), [`b90de58`](https://github.com/stella/anonymize/commit/b90de58df6d09cec68d72ce810b2dd07fe5a5694)]:
  - @stll/anonymize@2.2.0
  - @stll/anonymize-docx@2.2.0

## 2.1.0

### Patch Changes

- Updated dependencies [[`a427007`](https://github.com/stella/anonymize/commit/a427007925e7f1cf6c74e1796cd4e622affd0250)]:
  - @stll/anonymize@2.1.0
  - @stll/anonymize-docx@2.1.0
