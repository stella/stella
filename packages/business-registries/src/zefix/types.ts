export type ZefixRawFirm = {
  name?: string;
  ehraid?: number;
  uid?: string;
  uidFormatted?: string;
  chid?: string;
  chidFormatted?: string;
  legalSeatId?: number;
  legalSeat?: string;
  registerOfficeId?: number;
  legalFormId?: number;
  status?: string;
  shabDate?: string;
  deleteDate?: string | null;
  cantonalExcerptWeb?: string;
};

export type ZefixSearchResponse = {
  list?: ZefixRawFirm[];
  hasMoreResults?: boolean;
  offset?: number;
  maxEntries?: number;
  maxOffset?: number | null;
  error?: {
    code?: string;
    message?: string;
  };
};

export type ZefixCompanyStatus =
  | { type: "active" }
  | { type: "deleted"; deletedAt: string | null }
  | { type: "unknown"; upstreamValue: string | null };

export type ZefixCompany = {
  uid: string;
  uidFormatted: string;
  name: string;
  legalSeat: string | null;
  legalFormId: number | null;
  status: ZefixCompanyStatus;
  registryUrl: string | null;
};

export type ZefixSearchResult = {
  uid: string;
  uidFormatted: string;
  name: string;
  legalSeat: string | null;
  status: ZefixCompanyStatus;
  registryUrl: string | null;
};
