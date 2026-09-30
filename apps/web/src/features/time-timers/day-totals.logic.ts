import * as v from "valibot";

const MAX_DAILY_TARGET_MINUTES = 1440;

export const dailyTargetFormSchema = (invalidMessage: string) =>
  v.object({
    minutes: v.pipe(
      v.string(),
      v.trim(),
      v.check((value) => {
        if (value === "") {
          return true;
        }
        if (!/^\d+$/u.test(value)) {
          return false;
        }
        const minutes = Number(value);
        return minutes >= 1 && minutes <= MAX_DAILY_TARGET_MINUTES;
      }, invalidMessage),
      v.transform((value) => (value === "" ? null : Number(value))),
    ),
  });
