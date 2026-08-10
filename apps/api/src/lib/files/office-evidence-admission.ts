import { panic } from "better-result";

type AdmissionRelease = () => void;

export const createOfficeEvidenceAdmission = (limit: number) => {
  if (!Number.isInteger(limit) || limit < 1) {
    panic("Office evidence admission limit must be a positive integer");
  }

  let active = 0;
  return {
    tryAcquire: (): AdmissionRelease | null => {
      if (active >= limit) {
        return null;
      }
      active += 1;
      let released = false;
      return () => {
        if (released) {
          panic("Office evidence admission was released twice");
        }
        released = true;
        active -= 1;
      };
    },
  };
};
