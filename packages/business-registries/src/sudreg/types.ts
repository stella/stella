export type SudregAddress = {
  street: string | null;
  houseNumber: string | null;
  orientationNumber: string | null;
  orientationLetter: string | null;
  municipalityPart: string | null;
  municipality: string | null;
  textAddress: string;
};

export type SudregWarning = {
  type: "unexpected-address-format";
};

export type SudregCompany = {
  mbs: string;
  name: string;
  address: SudregAddress | null;
  shareCapital: string | null;
  legalForm: string | null;
  warnings: SudregWarning[];
  registryUrl: string;
};
