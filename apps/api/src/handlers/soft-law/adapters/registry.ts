import { Result } from "better-result";

import type { CorpusSourceDescriptor } from "@/api/lib/legal-search/corpus-source";
import { SoftLawIngestionError } from "@/api/lib/legal-search/soft-law-types";
import type {
  SoftLawAdapterConfiguration,
  SoftLawAuthority,
  SoftLawSourceAdapter,
} from "@/api/lib/legal-search/soft-law-types";

import { bfdiAdapter } from "./bfdi";
import { edpbAdapter } from "./edpb";
import { wp29Adapter } from "./wp29";

type SourceRegistration<Authority extends SoftLawAuthority> = {
  state: "registered";
  adapter: SoftLawSourceAdapter & { authority: Authority };
  descriptor: CorpusSourceDescriptor & {
    allowsRedistribution: false;
    allowsDerivedAi: false;
  };
  reuseNotice: string;
};

type AdmissionDisposition<Authority extends SoftLawAuthority> =
  | SourceRegistration<Authority>
  | { state: "held"; reason: string; adapter?: never }
  | { state: "unverified"; reason: string; adapter?: never }
  | {
      state: "none-found";
      checkedAt: string;
      evidence: readonly [string, ...string[]];
      adapter?: never;
    };

const unverified = {
  state: "unverified",
  reason: "Source coverage has not been verified",
} as const;
const held = {
  state: "held",
  reason: "Pending source-specific admission",
} as const;

/** These sources are ingestion-only; this registry confers no public-read permission. */
export const SOFT_LAW_ADMISSIONS = {
  "eu-edpb": {
    state: "registered",
    adapter: edpbAdapter,
    descriptor: {
      license: "permitted-redistribution",
      attribution:
        "European Data Protection Board; https://www.edpb.europa.eu/copyright_en",
      allowsRedistribution: false,
      allowsDerivedAi: false,
    },
    reuseNotice: "https://www.edpb.europa.eu/copyright_en",
  },
  "eu-wp29": {
    state: "registered",
    adapter: wp29Adapter,
    descriptor: {
      license: "restricted",
      attribution: "Article 29 Working Party; European Commission archive",
      allowsRedistribution: false,
      allowsDerivedAi: false,
    },
    reuseNotice: "https://commission.europa.eu/legal-notice_en",
  },
  "cz-uoou": held,
  "at-dsb": unverified,
  "be-apd": unverified,
  "bg-cpdp": unverified,
  "hr-azop": unverified,
  "cy-dpa": unverified,
  "dk-datatilsynet": unverified,
  "ee-aki": unverified,
  "fi-ombudsman": unverified,
  "fr-cnil": held,
  "de-bfdi": {
    state: "registered",
    adapter: bfdiAdapter,
    descriptor: {
      license: "restricted",
      attribution: "BfDI; https://www.bfdi.bund.de",
      allowsRedistribution: false,
      allowsDerivedAi: false,
    },
    reuseNotice: "https://www.bfdi.bund.de",
  },
  "el-hdpa": unverified,
  "hu-naih": unverified,
  "is-personuvernd": unverified,
  "ie-dpc": unverified,
  "it-garante": unverified,
  "lv-dvi": unverified,
  "li-dss": unverified,
  "lt-vdai": unverified,
  "lu-cnpd": unverified,
  "mt-idpc": unverified,
  "nl-ap": unverified,
  "no-datatilsynet": unverified,
  "pl-uodo": unverified,
  "pt-cnpd": unverified,
  "ro-anspdcp": unverified,
  "sk-uoou": unverified,
  "si-ip": unverified,
  "es-aepd": held,
  "se-imy": unverified,
  "eu-edps": unverified,
  "de-dsk": held,
  "de-bw": unverified,
  "de-by-baylfd": unverified,
  "de-by-baylda": unverified,
  "de-be": unverified,
  "de-bb": unverified,
  "de-hb": unverified,
  "de-hh": unverified,
  "de-he": unverified,
  "de-mv": unverified,
  "de-ni": unverified,
  "de-nw": unverified,
  "de-rp": unverified,
  "de-sl": unverified,
  "de-sn": unverified,
  "de-st": unverified,
  "de-sh": unverified,
  "de-th": unverified,
  "es-apdcat": unverified,
  "es-avpd": unverified,
  "es-ctpd": unverified,
  "at-pdk": unverified,
  "be-vtc": unverified,
  "be-coc": unverified,
  "be-comitei": unverified,
  "be-comitep": unverified,
} as const satisfies {
  [Authority in SoftLawAuthority]: AdmissionDisposition<Authority>;
};

export type RegisteredSoftLawAuthority = {
  [
    Authority in SoftLawAuthority
  ]: (typeof SOFT_LAW_ADMISSIONS)[Authority] extends {
    state: "registered";
  }
    ? Authority
    : never;
}[SoftLawAuthority];

type RegisteredSoftLawAdapter =
  (typeof SOFT_LAW_ADMISSIONS)[RegisteredSoftLawAuthority]["adapter"];

export const configureSoftLawAdapter = async (
  adapter: RegisteredSoftLawAdapter,
  configuration: SoftLawAdapterConfiguration,
) => {
  if ("configure" in adapter) {
    return await adapter.configure(configuration);
  }
  if (configuration.type === "default") {
    return Result.ok(adapter);
  }
  return Result.err(
    new SoftLawIngestionError({
      message: "This source does not accept an admission file",
    }),
  );
};
