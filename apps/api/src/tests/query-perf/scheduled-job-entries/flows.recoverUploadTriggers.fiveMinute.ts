import type { ScheduledJobMeasurement } from "../measurement-definition";
import { recoveryMeasurement } from "../recovery-measurement";

export default recoveryMeasurement("upload") satisfies ScheduledJobMeasurement;
