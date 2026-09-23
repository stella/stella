// A folio parser on raw bytes skips the scan.
// oxlint-disable-next-line scanned-file-boundary/scanned-file-boundary
import { FolioDocxReviewer, parseDocx } from "@stll/folio-core/server";
// Type-only imports of folio stay valid.
import type { ParseOptions } from "@stll/folio-core/server";

// The brand's schema would mint keys from any string.
// oxlint-disable-next-line scanned-file-boundary/scanned-file-boundary
import { fileKeySchema } from "@/api/lib/file-key";
import type * as keys from "@/api/lib/file-key";
// Only the translation review module may wrap its own output.
// oxlint-disable-next-line scanned-file-boundary/scanned-file-boundary
import { derivedScannedFile } from "@/api/lib/file-scan/document-parsers";
// Publisher downloads are for case-law adapters only.
// oxlint-disable-next-line scanned-file-boundary/scanned-file-boundary
import { publisherDocument } from "@/api/lib/file-scan/publisher-document";
// The scan module's mint would wrap unscanned bytes.
// oxlint-disable-next-line scanned-file-boundary/scanned-file-boundary
import { mintScannedFile } from "@/api/lib/file-scan/scanned-file";
import type { ScannedFile as ParserFile } from "@/api/lib/file-scan/scanned-file";

declare class ScannedFile {
  private constructor();
  readonly bytes: ArrayBuffer;
}
type FileKey = string & { readonly __fileKey: true };
type OtherKey = string & { readonly __otherKey: true };

declare const bytes: ArrayBuffer;
declare const stagingKey: string;
declare const scanned: ScannedFile;

// Raw bytes forged into a scan proof: the rule must report it.
// oxlint-disable-next-line scanned-file-boundary/scanned-file-boundary, no-unjustified-double-assertion/no-unjustified-double-assertion, typescript/no-unsafe-type-assertion
const _forgedFile = bytes as unknown as ScannedFile;

// A staging key passed off as a stored file key.
// oxlint-disable-next-line scanned-file-boundary/scanned-file-boundary, typescript/no-unsafe-type-assertion
const _forgedKey = stagingKey as FileKey;

// Renamed bindings forge the same proof: an import alias, a namespace member,
// and a local type alias declared after its use.
// oxlint-disable-next-line scanned-file-boundary/scanned-file-boundary, no-unjustified-double-assertion/no-unjustified-double-assertion, typescript/no-unsafe-type-assertion
const _aliasedFile = bytes as unknown as ParserFile;
// oxlint-disable-next-line scanned-file-boundary/scanned-file-boundary, typescript/no-unsafe-type-assertion
const _namespacedKey = stagingKey as keys.FileKey;
// oxlint-disable-next-line scanned-file-boundary/scanned-file-boundary, typescript/no-unsafe-type-assertion
const _laterAliasKey = stagingKey as LaterKey;
type LaterKey = FileKey;

// The reviewer parses raw bytes too.
// oxlint-disable-next-line scanned-file-boundary/scanned-file-boundary
const _reviewer = FolioDocxReviewer.fromBuffer(bytes);
declare const parseOptions: ParseOptions;

// Instances built around the private constructor.
// oxlint-disable-next-line scanned-file-boundary/scanned-file-boundary
const _fromPrototype: unknown = Object.create(ScannedFile.prototype);

// Other brands, and reading a real ScannedFile, stay valid for this rule.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const _otherKey = stagingKey as OtherKey;
const _scannedBytes = scanned.bytes;

export const __scannedFileBoundaryFixture = {
  parseDocx,
  derivedScannedFile,
  publisherDocument,
  parseOptions,
  _reviewer,
  fileKeySchema,
  mintScannedFile,
  _forgedFile,
  _forgedKey,
  _aliasedFile,
  _namespacedKey,
  _laterAliasKey,
  _fromPrototype,
  _otherKey,
  _scannedBytes,
};
