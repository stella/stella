# @stll/anonymize-pdf

## 2.6.2

### Patch Changes

- Updated dependencies [[`d77a69b`](https://github.com/stella/anonymize/commit/d77a69b5d4b97105cff3fe1fde1d00201dda8102)]:
  - @stll/anonymize@2.6.2

## 2.6.1

### Patch Changes

- Updated dependencies [[`deb2d7c`](https://github.com/stella/anonymize/commit/deb2d7c3c2dd346589478fd8191bea088a1563b7)]:
  - @stll/anonymize@2.6.1

## 2.6.0

### Patch Changes

- Updated dependencies []:
  - @stll/anonymize@2.6.0

## 2.5.0

### Patch Changes

- Updated dependencies [[`2414231`](https://github.com/stella/anonymize/commit/2414231ba7f016787c10ca66fd6b40b71a10d251), [`83d58ef`](https://github.com/stella/anonymize/commit/83d58efecb0e8f0ef9161bc7568d8c397b5072ab)]:
  - @stll/anonymize@2.5.0

## 2.4.2

### Patch Changes

- Updated dependencies [[`e019d1d`](https://github.com/stella/anonymize/commit/e019d1dee10a76660fd7cf041dfffe165acc1c24), [`458db0a`](https://github.com/stella/anonymize/commit/458db0a9c9b4eaa778af93be4e453c8057365f24), [`8bb15b6`](https://github.com/stella/anonymize/commit/8bb15b632af0c045fdfd87559e9a330fa802cad1), [`9ed1c05`](https://github.com/stella/anonymize/commit/9ed1c05d6cfb06ef66d7a6be4ed7935a4fa87fca), [`3073898`](https://github.com/stella/anonymize/commit/3073898db52a5b178efac30cffc37875f3b81b13), [`9821929`](https://github.com/stella/anonymize/commit/982192969e618a49ea5989ce6961ce68d33e89f2), [`e1ca10d`](https://github.com/stella/anonymize/commit/e1ca10d4260fb4911fedfa921d0cc96687803449), [`ae46b72`](https://github.com/stella/anonymize/commit/ae46b720c37dd7b5c84fbe419971ff3b7df8db0e), [`aaff4d7`](https://github.com/stella/anonymize/commit/aaff4d7e369eb3b76f420a648f53a7a698011d11), [`a66cd04`](https://github.com/stella/anonymize/commit/a66cd04e2fd0af5ab6c54cac0bbf6efd03edc492), [`d937fd6`](https://github.com/stella/anonymize/commit/d937fd67b08a3ee73e4af7e67c656c95edeb6af4), [`b8adef9`](https://github.com/stella/anonymize/commit/b8adef93d03260f736f5e642bacbfbcf7842fd3b), [`cced835`](https://github.com/stella/anonymize/commit/cced8358593a4381d7323a26ad7bad99547b69af)]:
  - @stll/anonymize@2.4.2

## 2.4.1

### Patch Changes

- Updated dependencies [[`6469935`](https://github.com/stella/anonymize/commit/64699354e210eed7eadaa2650d06fd195942c5c6), [`20071a8`](https://github.com/stella/anonymize/commit/20071a8a8d0841cb1c7bf1a7dd41f183966f0ab3), [`bf1eda3`](https://github.com/stella/anonymize/commit/bf1eda396973bc04986c75cb6b5ec63214e24799), [`3e95d22`](https://github.com/stella/anonymize/commit/3e95d22a8768539b539fdbb39df6e1e5d4d8e88f), [`4f5140f`](https://github.com/stella/anonymize/commit/4f5140fbaddbb69aafa68dec98bd06c4b2b7a45e), [`bf1eda3`](https://github.com/stella/anonymize/commit/bf1eda396973bc04986c75cb6b5ec63214e24799), [`4f5140f`](https://github.com/stella/anonymize/commit/4f5140fbaddbb69aafa68dec98bd06c4b2b7a45e)]:
  - @stll/anonymize@2.4.1

## 2.4.0

### Minor Changes

- [#344](https://github.com/stella/anonymize/pull/344) [`66b250b`](https://github.com/stella/anonymize/commit/66b250bb4d633715402784210428341047c73816) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add a bounded local Poppler/Tesseract PDF observation adapter and an atomic,
  non-overwriting CLI workflow for verified destructive image-only output. OCR
  uses one explicit language pack and the certificate remains honest about recall.

- [#338](https://github.com/stella/anonymize/pull/338) [`3923dbe`](https://github.com/stella/anonymize/commit/3923dbe6d0b1fe202e1a3a23a54166aee5885d64) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add a bounded, cross-runtime PDF structure and coverage inspection contract.
  Inventory forms, annotations, attachments, metadata, JavaScript, XFA, optional
  content, signatures, and image objects without claiming that inspection or an
  opaque rectangle overlay anonymizes a PDF.

- [#342](https://github.com/stella/anonymize/pull/342) [`41f440c`](https://github.com/stella/anonymize/commit/41f440c19ab7b8cebe59f4cbb2c2dcda47b4dd67) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add a fail-closed, provider-neutral PDF raster anonymization contract with
  exact Node and Python document-profile parity. The surface emits a verified,
  fresh image-only PDF and never retains source PDF objects or hidden content.

### Patch Changes

- Updated dependencies [[`a8ffd9b`](https://github.com/stella/anonymize/commit/a8ffd9be1ad3115ae0f405d5eb0880589377a98a), [`6b547a1`](https://github.com/stella/anonymize/commit/6b547a1e675ba5219d3a97de7d2a6b5213ebad7c), [`ac27bc1`](https://github.com/stella/anonymize/commit/ac27bc1b620d847daadcd8559919258867c7e8bb), [`3923dbe`](https://github.com/stella/anonymize/commit/3923dbe6d0b1fe202e1a3a23a54166aee5885d64), [`ed699d9`](https://github.com/stella/anonymize/commit/ed699d932ce40c5ca5749b6235146b713eba78b6), [`97cdfff`](https://github.com/stella/anonymize/commit/97cdfff8cf42851e2f7d5d1b866cfadfaaa5dbc0), [`41f440c`](https://github.com/stella/anonymize/commit/41f440c19ab7b8cebe59f4cbb2c2dcda47b4dd67), [`db7c4d1`](https://github.com/stella/anonymize/commit/db7c4d1908750585e4e294e380cb826a36b48375), [`984c7bb`](https://github.com/stella/anonymize/commit/984c7bb6b8d2c8ec7855af67b104bd8c2e4b0b38)]:
  - @stll/anonymize@2.4.0
