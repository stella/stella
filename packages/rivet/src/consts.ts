export const isDev = () => {
  if (typeof process !== "undefined") {
    return process.env.NODE_ENV !== "production";
  }

  if (import.meta !== undefined) {
    return import.meta.env.DEV;
  }

  return false;
};

export const getActorRegion = () => (isDev() ? undefined : "eu-central-1");
