/**
 * The EICAR anti-malware test file: a harmless string every scanner reports
 * as malware, so a test can prove that a malware finding refuses a file.
 * It is assembled at run time, so the repository never holds the signature
 * itself and a scanner on a developer machine has nothing to quarantine.
 */
export const eicarTestFile = (): string =>
  [
    "X5O!P%@AP[4",
    "\\PZX54(P^)7CC)7}$",
    "EICAR-STANDARD-",
    "ANTIVIRUS-TEST-FILE!$H+H*",
  ].join("");
