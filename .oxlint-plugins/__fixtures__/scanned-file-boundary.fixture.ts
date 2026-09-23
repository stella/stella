// The brand's schema would mint keys from any string.
// oxlint-disable-next-line scanned-file-boundary/scanned-file-boundary
import { fileKeySchema } from "@/api/lib/file-key";

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

// Instances built around the private constructor.
// oxlint-disable-next-line scanned-file-boundary/scanned-file-boundary
const _fromPrototype: unknown = Object.create(ScannedFile.prototype);

// Other brands, and reading a real ScannedFile, stay valid for this rule.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const _otherKey = stagingKey as OtherKey;
const _scannedBytes = scanned.bytes;

export const __scannedFileBoundaryFixture = {
  fileKeySchema,
  _forgedFile,
  _forgedKey,
  _fromPrototype,
  _otherKey,
  _scannedBytes,
};
