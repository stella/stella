import { trimToNull } from "../shared/strings.js";
import type {
  ZefixCompany,
  ZefixCompanyStatus,
  ZefixRawFirm,
  ZefixSearchResult,
} from "./types.js";
import { formatUid, normalizeUid } from "./validation.js";

const parseStatus = (raw: ZefixRawFirm): ZefixCompanyStatus => {
  const status = trimToNull(raw.status)?.toUpperCase() ?? null;
  if (status === "EXISTIEREND") {
    return { type: "active" };
  }
  if (status === "GELOESCHT") {
    return { type: "deleted", deletedAt: trimToNull(raw.deleteDate) };
  }
  return { type: "unknown", upstreamValue: status };
};

export const parseFirm = (raw: ZefixRawFirm): ZefixCompany | null => {
  const uidSource = trimToNull(raw.uidFormatted) ?? trimToNull(raw.uid);
  const name = trimToNull(raw.name);
  if (!uidSource || !name) {
    return null;
  }
  const uid = normalizeUid(uidSource);
  if (!/^\d{9}$/u.test(uid)) {
    return null;
  }
  return {
    uid,
    uidFormatted: trimToNull(raw.uidFormatted) ?? formatUid(uid),
    name,
    legalSeat: trimToNull(raw.legalSeat),
    legalFormId:
      typeof raw.legalFormId === "number" && Number.isFinite(raw.legalFormId)
        ? raw.legalFormId
        : null,
    status: parseStatus(raw),
    registryUrl: trimToNull(raw.cantonalExcerptWeb),
  };
};

export const parseSearchEntry = (
  raw: ZefixRawFirm,
): ZefixSearchResult | null => {
  const company = parseFirm(raw);
  if (!company) {
    return null;
  }
  return {
    uid: company.uid,
    uidFormatted: company.uidFormatted,
    name: company.name,
    legalSeat: company.legalSeat,
    status: company.status,
    registryUrl: company.registryUrl,
  };
};
