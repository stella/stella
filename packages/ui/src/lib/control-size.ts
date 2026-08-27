const CONTROL_SIZE = Object.freeze({
  sm: "sm",
  default: "default",
  lg: "lg",
} as const);

type ControlSize = (typeof CONTROL_SIZE)[keyof typeof CONTROL_SIZE];

const CONTROL_SIZES = Object.freeze(Object.values(CONTROL_SIZE));

export { CONTROL_SIZE, CONTROL_SIZES, type ControlSize };
