import { bearer } from "better-auth/plugins";

export const createSessionBearer = () => {
  const plugin = bearer({ requireSignature: true });
  return {
    ...plugin,
    hooks: { before: plugin.hooks.before },
  };
};
