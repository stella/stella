import { Result } from "better-result";

import { EML_MIME_TYPE } from "@stll/api-contract/email-mime-types";

import type { ZipEntry } from "@/api/lib/file-scan/zip";
import type { ContainerMember } from "@/api/lib/files/asic-preview-worker";
import { readCmsSigners } from "@/api/lib/files/cms-signed-data";
import {
  openDocumentArchive,
  readArchiveEntry,
} from "@/api/lib/files/document-archive";
import { emailBodyToText, parseEmail } from "@/api/lib/files/email-to-html";
import {
  dossierDocumentName,
  dossierLimit,
  invalidDossier,
  MAX_DOSSIER_DOCUMENTS,
  MAX_DOSSIER_SIGNATURES,
  type SignedDossier,
  SignedDossierParseError,
} from "@/api/lib/files/signed-dossier";
import {
  readXadesSigners,
  type XadesSigner,
  xmlSignatures,
} from "@/api/lib/files/xades-signers";
import { parseStandaloneXml } from "@/api/lib/files/xml-document-package";

// NBÚ, "Formáty zaručených elektronických podpisov" v3.0 (2009), Annex E.2:
// entries are named by type letter and insertion time ("YYYYMMDDhhmmssZ",
// optionally followed by a sequence number), optionally under one main
// directory "D<time>" with Certificate, Revocation, Policy and Other folders.
// Documents travel in "M" MIME envelopes (E.1); "S" entries sign them.
const MAIN_DIRECTORY = /^D\d{14}Z\d*$/u;
const AUXILIARY_FOLDERS = new Set(["Certificate", "Revocation", "Policy"]);
const ITEM = /^(CRL|OCSP|[SMAPC])\d{14}Z\d*\.([a-z0-9]+)$/iu;
const MAX_SIGNATURE_XML_BYTES = 8 * 1024 * 1024;
const PKCS7_SIGNATURE_TYPES = new Set([
  "application/pkcs7-signature",
  "application/x-pkcs7-signature",
]);

type Inventory = {
  envelopes: { fileName: string; entry: ZipEntry }[];
  signatures: { extension: string; entry: ZipEntry }[];
  others: { fileName: string; entry: ZipEntry }[];
};

const classify = (
  entries: ReadonlyMap<string, ZipEntry>,
): Result<Inventory, SignedDossierParseError> => {
  const inventory: Inventory = { envelopes: [], signatures: [], others: [] };
  for (const [path, entry] of entries) {
    if (path.endsWith("/")) {
      continue;
    }
    const parts = path.split("/");
    if (parts.length > 1 && MAIN_DIRECTORY.test(parts[0] ?? "")) {
      parts.shift();
    }
    const fileName = parts.at(-1) ?? path;
    const [folder] = parts.length > 1 ? parts : [];
    if (folder !== undefined) {
      // Other holds attached files; an unknown folder is listed the same way
      // so nothing is silently dropped. Validation data is not a document.
      if (!AUXILIARY_FOLDERS.has(folder)) {
        inventory.others.push({ fileName: path, entry });
      }
      continue;
    }
    const item = ITEM.exec(fileName);
    const type = item?.[1]?.toUpperCase();
    const extension = item?.[2]?.toLowerCase() ?? "";
    if (type === "M" && extension === "eml") {
      inventory.envelopes.push({ fileName: path, entry });
    } else if (type === "S" && (extension === "p7s" || extension === "xml")) {
      inventory.signatures.push({ extension, entry });
    } else if (type === undefined) {
      inventory.others.push({ fileName: path, entry });
    }
    // Integrity signatures, policies, certificates and revocation data
    // support validation and are not documents.
  }
  if (inventory.envelopes.length === 0) {
    return invalidDossier("The container has no ZEPf document envelope");
  }
  return Result.ok(inventory);
};

const entryBytes = (entry: ZipEntry) => {
  const content = readArchiveEntry(entry);
  return content.isOk()
    ? Result.ok(content.value)
    : invalidDossier(content.error.message);
};

const signatureSigners = (
  bytes: Uint8Array,
  extension: string,
  id: string,
): XadesSigner[] => {
  if (extension === "p7s") {
    const signers = readCmsSigners(bytes, id);
    return signers.isOk()
      ? signers.value.map(({ id: signerId, name }) => ({ id: signerId, name }))
      : [{ id, name: null }];
  }
  const parsed = parseStandaloneXml(bytes, MAX_SIGNATURE_XML_BYTES);
  const signatures = parsed.isOk() ? xmlSignatures(parsed.value) : [];
  return signatures.length > 0
    ? readXadesSigners(signatures, id)
    : [{ id, name: null }];
};

const envelopeName = (fileName: string) =>
  `${
    fileName
      .split("/")
      .at(-1)
      ?.replace(/\.eml$/iu, "") ?? fileName
  }.txt`;

/** Reads a ZEPf container's enveloped documents and stated signers. */
export const readZepContainer = async (
  bytes: Uint8Array,
): Promise<Result<SignedDossier, SignedDossierParseError>> => {
  const archive = await openDocumentArchive(bytes);
  if (archive.isErr()) {
    return Result.err(
      new SignedDossierParseError({
        message: archive.error.message,
        reason: archive.error.reason,
      }),
    );
  }
  const inventory = classify(archive.value);
  if (inventory.isErr()) {
    return Result.err(inventory.error);
  }
  const { envelopes, signatures, others } = inventory.value;
  const documents: ContainerMember[] = [];
  const signers: XadesSigner[] = [];
  for (const [index, { extension, entry }] of signatures.entries()) {
    const content = entryBytes(entry);
    if (content.isErr()) {
      return Result.err(content.error);
    }
    signers.push(
      ...signatureSigners(content.value, extension, `signature-${index}`),
    );
  }
  for (const [index, { fileName, entry }] of envelopes.entries()) {
    const content = entryBytes(entry);
    if (content.isErr()) {
      return Result.err(content.error);
    }
    const email = await parseEmail(
      new Uint8Array(content.value).buffer,
      EML_MIME_TYPE,
    );
    if (email.isErr()) {
      return invalidDossier("The container's document envelope is unreadable");
    }
    const { body, attachments } = email.value;
    const text = emailBodyToText(body);
    if (text.trim()) {
      documents.push({
        fileName: envelopeName(fileName),
        bytes: new TextEncoder().encode(text),
      });
    }
    for (const attachment of attachments) {
      const mimeType = attachment.mimeType
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      // E.1: an S/MIME envelope carries its own detached CMS signature.
      if (mimeType !== undefined && PKCS7_SIGNATURE_TYPES.has(mimeType)) {
        signers.push(
          ...signatureSigners(
            attachment.bytes,
            "p7s",
            `envelope-${index}-signature-${signers.length}`,
          ),
        );
        continue;
      }
      documents.push({
        fileName: dossierDocumentName(
          attachment.fileName ?? undefined,
          documents.length,
        ),
        bytes: attachment.bytes,
      });
    }
  }
  for (const { fileName, entry } of others) {
    const content = entryBytes(entry);
    if (content.isErr()) {
      return Result.err(content.error);
    }
    documents.push({ fileName, bytes: content.value });
  }
  if (documents.length > MAX_DOSSIER_DOCUMENTS) {
    return dossierLimit("The container holds too many documents");
  }
  if (signers.length > MAX_DOSSIER_SIGNATURES) {
    return dossierLimit("The container holds too many signatures");
  }
  return Result.ok({ documents, signers });
};
