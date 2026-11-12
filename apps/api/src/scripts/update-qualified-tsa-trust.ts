/**
 * Regenerate the qualified timestamp trust bundle in
 * `src/lib/files/pdf-signing/trust/` from the EU trusted lists.
 *
 * Reads the EU List of Trusted Lists (LOTL), follows its pointers to the
 * member states' (and EEA states') XML trusted lists (ETSI TS 119 612), and
 * keeps the service digital identities of every qualified time-stamping
 * service (`Svctype/TSA/QTST`) whose current status is `granted` and whose
 * certificate has not expired. The result is split in two files:
 *
 * - `eu-qualified-tsa-anchors.pem`: services listed by a CA certificate,
 *   used as trust anchors;
 * - `eu-qualified-tsa-units.txt`: services listed by their timestamping
 *   unit's own certificate, pinned by its SHA-256. These are most of the
 *   entries, and a timestamp token always carries its unit's certificate,
 *   so a fingerprint is all the check needs.
 *
 * Not done here: verifying the XML signatures of the LOTL and of each
 * trusted list (XMLDSig over exclusive canonicalisation, with the LOTL's
 * signing certificates published in the Official Journal). The lists are
 * fetched over HTTPS from the addresses the LOTL names, and the generated
 * diff is reviewed before it is committed.
 *
 * A trusted list that cannot be fetched fails the run, so a bundle never
 * silently loses a territory; `--allow-missing=PT,CY` accepts named
 * failures and records them in the files' headers.
 *
 * Usage:  bun run src/scripts/update-qualified-tsa-trust.ts [--allow-missing=XX,YY]
 */

import { panic, Result } from "better-result";
import path from "node:path";
import { parseArgs } from "node:util";
import * as pkijs from "pkijs";

import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

import { safeOutboundFetchBytes } from "@/api/lib/auth/authorized-outbound-fetch";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";

const LOTL_URL = "https://ec.europa.eu/tools/lotl/eu-lotl.xml";
const QTST_SERVICE_TYPE = "http://uri.etsi.org/TrstSvc/Svctype/TSA/QTST";
const GRANTED_STATUS =
  "http://uri.etsi.org/TrstSvc/TrustedList/Svcstatus/granted";
const TSL_XML_MIME_TYPE = "application/vnd.etsi.tsl+xml";
const EU_GENERIC_TSL_TYPE =
  "http://uri.etsi.org/TrstSvc/TrustedList/TSLType/EUgeneric";
/**
 * The LOTL points at itself, and still at the frozen list of a former
 * member state whose services are no longer qualified under eIDAS.
 */
const SKIPPED_TERRITORIES = new Set(["EU", "UK"]);

/** The largest national lists are a few megabytes. */
const LIST_MAX_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;
const ATTEMPTS = 2;

const BASIC_CONSTRAINTS_OID = "2.5.29.19";
const COMMON_NAME_OID = "2.5.4.3";
const ORGANIZATION_OID = "2.5.4.10";

const OUTPUT_DIRECTORY = path.join(
  import.meta.dir,
  "../lib/files/pdf-signing/trust",
);
const ANCHORS_FILE = "eu-qualified-tsa-anchors.pem";
const UNITS_FILE = "eu-qualified-tsa-units.txt";

/**
 * One element's contents, whatever namespace prefix the list's producer
 * chose. The elements read here never nest inside themselves.
 */
const elements = (xml: string, name: string): string[] =>
  [
    ...xml.matchAll(
      new RegExp(
        `<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`,
        "gu",
      ),
    ),
  ].map(([, content]) => content ?? "");

/** The predefined XML entities; lists carry no others. */
const XML_ENTITIES = new Map([
  ["&amp;", "&"],
  ["&apos;", "'"],
  ["&gt;", ">"],
  ["&lt;", "<"],
  ["&quot;", '"'],
]);

const text = (xml: string, name: string): string | undefined => {
  const content = elements(xml, name).at(0);
  return content
    ?.trim()
    .replaceAll(
      /&(?:amp|apos|gt|lt|quot);/gu,
      (entity) => XML_ENTITIES.get(entity) ?? entity,
    );
};

const withoutComments = (xml: string) =>
  xml.replaceAll(/<!--[\s\S]*?-->/gu, "");

/**
 * The HTTPS form of a list address: the guarded fetch refuses plain HTTP,
 * and a list published at an `http:` address in the LOTL is fetched from
 * the same host over HTTPS instead.
 */
const overHttps = (url: string) => {
  const parsed = new URL(url);
  if (parsed.protocol === "http:") {
    parsed.protocol = "https:";
  }
  return parsed.toString();
};

/** GET `url`, following redirects through the same guarded fetch. */
const download = async (
  permit: ThirdPartyOutboundPermit,
  url: string,
): Promise<Result<string, string>> => {
  let current = overHttps(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    // oxlint-disable-next-line no-network-await-in-loop/no-network-await-in-loop -- each redirect hop is known only from the previous answer.
    const response = await safeOutboundFetchBytes({
      permit,
      maxBytes: LIST_MAX_BYTES,
      redirect: "manual",
      timeout: { type: "headers", ms: REQUEST_TIMEOUT_MS },
      url: current,
    });
    if (Result.isError(response)) {
      return Result.err(response.error.message);
    }
    const { body, headers, ok, status } = response.value;
    const location = headers.get("location");
    if (status >= 300 && status < 400 && location !== null) {
      current = overHttps(new URL(location, current).toString());
      continue;
    }
    if (!ok) {
      return Result.err(`HTTP ${status}`);
    }
    return Result.ok(new TextDecoder().decode(body));
  }
  return Result.err(`more than ${MAX_REDIRECTS} redirects`);
};

const downloadWithRetry = async (
  permit: ThirdPartyOutboundPermit,
  url: string,
): Promise<Result<string, string>> => {
  let last: Result<string, string> = Result.err("not attempted");
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    last = await download(permit, url);
    if (Result.isOk(last)) {
      return last;
    }
  }
  return last;
};

type ListPointer = { territory: string; url: string };

/** The machine-readable national lists the LOTL points at. */
const nationalLists = (lotl: string): ListPointer[] =>
  elements(withoutComments(lotl), "OtherTSLPointer").flatMap((pointer) => {
    const territory = text(pointer, "SchemeTerritory");
    const url = text(pointer, "TSLLocation");
    if (
      territory === undefined ||
      url === undefined ||
      SKIPPED_TERRITORIES.has(territory) ||
      text(pointer, "MimeType") !== TSL_XML_MIME_TYPE ||
      text(pointer, "TSLType") !== EU_GENERIC_TSL_TYPE
    ) {
      return [];
    }
    return [{ territory, url }];
  });

/** Certificates of the granted qualified time-stamping services in a list. */
const grantedTimestampServiceCertificates = (list: string): Uint8Array[] =>
  elements(withoutComments(list), "TSPService").flatMap((service) => {
    // The current state; earlier states sit in ServiceHistory, which this
    // element never contains.
    const information = elements(service, "ServiceInformation").at(0);
    if (
      information === undefined ||
      text(information, "ServiceTypeIdentifier") !== QTST_SERVICE_TYPE ||
      text(information, "ServiceStatus") !== GRANTED_STATUS
    ) {
      return [];
    }
    return elements(information, "ServiceDigitalIdentity")
      .flatMap((identity) => elements(identity, "X509Certificate"))
      .map(
        (encoded) =>
          new Uint8Array(Buffer.from(encoded.replaceAll(/\s/gu, ""), "base64")),
      );
  });

type ServiceCertificate = {
  ca: boolean;
  der: Uint8Array;
  fingerprint: string;
  name: string;
  notAfter: Date;
  territory: string;
};

const attribute = (certificate: pkijs.Certificate, oid: string) => {
  const value = certificate.subject.typesAndValues.find(
    ({ type }) => type === oid,
  )?.value.valueBlock.value;
  return typeof value === "string" ? value : undefined;
};

const isCa = (certificate: pkijs.Certificate) => {
  const extension = certificate.extensions?.find(
    ({ extnID }) => extnID === BASIC_CONSTRAINTS_OID,
  );
  if (extension === undefined) {
    return false;
  }
  return Result.try(
    () =>
      pkijs.BasicConstraints.fromBER(
        new Uint8Array(extension.extnValue.valueBlock.valueHexView),
      ).cA,
  ).unwrapOr(false);
};

const describeCertificate = (
  der: Uint8Array,
  territory: string,
): ServiceCertificate | null => {
  const parsed = Result.try(() =>
    pkijs.Certificate.fromBER(new Uint8Array(der)),
  );
  if (Result.isError(parsed)) {
    return null;
  }
  const certificate = parsed.value;
  return {
    ca: isCa(certificate),
    der,
    fingerprint: hashSha256Hex(der),
    name:
      attribute(certificate, COMMON_NAME_OID) ??
      attribute(certificate, ORGANIZATION_OID) ??
      "(unnamed)",
    notAfter: certificate.notAfter.value,
    territory,
  };
};

const pem = (der: Uint8Array) =>
  `-----BEGIN CERTIFICATE-----\n${Buffer.from(der)
    .toBase64()
    .replaceAll(/(.{64})/gu, "$1\n")
    .trimEnd()}\n-----END CERTIFICATE-----\n`;

const day = (date: Date) => date.toISOString().slice(0, 10);

const header = ({
  generated,
  missing,
  summary,
}: {
  generated: Date;
  missing: readonly string[];
  summary: string;
}) =>
  [
    "# Generated by apps/api/src/scripts/update-qualified-tsa-trust.ts; do not edit.",
    `# Source: ${LOTL_URL} and the national trusted lists it points at,`,
    `# read on ${day(generated)}. ${summary}`,
    "# The trusted lists' XML signatures were not verified; see the script.",
    ...(missing.length > 0
      ? [`# Trusted lists that could not be read: ${missing.join(", ")}.`]
      : []),
    "",
  ].join("\n");

const { values: options } = parseArgs({
  options: { "allow-missing": { type: "string", default: "" } },
});
const allowedMissing = new Set(
  options["allow-missing"]
    .split(",")
    .map((territory) => territory.trim())
    .filter((territory) => territory !== ""),
);

const permit = grantThirdPartyOutboundPermit();
const generated = new Date();

const lotl = await downloadWithRetry(permit, LOTL_URL);
const pointers = nationalLists(
  Result.isError(lotl)
    ? panic(`the LOTL could not be read: ${lotl.error}`)
    : lotl.value,
);
if (pointers.length === 0) {
  panic("the LOTL points at no national trusted lists");
}

const found = new Map<string, ServiceCertificate>();
const missing: string[] = [];
const failures: string[] = [];
for (const { territory, url } of pointers) {
  const list = await downloadWithRetry(permit, url);
  if (Result.isError(list)) {
    process.stdout.write(`${territory}: not read\n`);
    missing.push(territory);
    failures.push(`${territory} (${url}: ${list.error})`);
    continue;
  }
  const certificates = grantedTimestampServiceCertificates(list.value)
    .map((der) => describeCertificate(der, territory))
    .filter((entry) => entry !== null)
    .filter((entry) => entry.notAfter.getTime() > generated.getTime());
  for (const entry of certificates) {
    if (!found.has(entry.fingerprint)) {
      found.set(entry.fingerprint, entry);
    }
  }
  process.stdout.write(`${territory}: ${certificates.length} certificate(s)\n`);
}

const unexpected = missing.filter(
  (territory) => !allowedMissing.has(territory),
);
if (unexpected.length > 0) {
  panic(
    `trusted lists could not be read: ${failures.join("; ")}. Retry, or accept with --allow-missing=${unexpected.join(",")}`,
  );
}

/** Code-point order: territory codes and hex fingerprints, not prose. */
const compareCodes = (left: string, right: string) =>
  Number(left > right) - Number(left < right);
const ordered = [...found.values()].toSorted(
  (left, right) =>
    compareCodes(left.territory, right.territory) ||
    compareCodes(left.fingerprint, right.fingerprint),
);
const anchors = ordered.filter(({ ca }) => ca);
const units = ordered.filter(({ ca }) => !ca);

const anchorsHeader = header({
  generated,
  missing,
  summary: `${anchors.length} CA certificates of granted QTST services.`,
});
const anchorEntries = anchors
  .map(
    ({ der, name, notAfter, territory }) =>
      `\n# ${territory}  ${name}  (until ${day(notAfter)})\n${pem(der)}`,
  )
  .join("");
await Bun.write(
  path.join(OUTPUT_DIRECTORY, ANCHORS_FILE),
  `${anchorsHeader}${anchorEntries}`,
);

const unitsHeader = header({
  generated,
  missing,
  summary: `SHA-256 of ${units.length} unit certificates of granted QTST services.`,
});
const unitLines = units
  .map(
    ({ fingerprint, name, notAfter, territory }) =>
      `${fingerprint}  ${territory}  ${day(notAfter)}  ${name}\n`,
  )
  .join("");
await Bun.write(
  path.join(OUTPUT_DIRECTORY, UNITS_FILE),
  `${unitsHeader}# sha256  territory  valid-until  subject\n${unitLines}`,
);

process.stdout.write(
  `${anchors.length} anchors, ${units.length} pinned units written to ${OUTPUT_DIRECTORY}\n`,
);
