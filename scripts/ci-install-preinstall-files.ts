// These files execute before dependencies exist. Keep this list shared with the
// import guard and the narrow path-lint exception that enforces that contract.
export const CI_INSTALL_PREINSTALL_FILES = [
  "scripts/ci-install.ts",
  "scripts/ci-install-store.ts",
] as const;
