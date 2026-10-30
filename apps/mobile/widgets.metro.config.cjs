const path = require("node:path");
const app = require("./metro.config.cjs");
const widgets = require("expo-widgets/metro.config.js");

// Retain Expo's widget runtime stubs and transformer, with the app's roots
// and resolution for every dependency the widget runtime does not replace.
module.exports = {
  ...widgets,
  projectRoot: app.projectRoot,
  watchFolders: [...new Set([...app.watchFolders, widgets.projectRoot])],
  resolver: {
    ...app.resolver,
    resolveRequest(context, moduleName, platform) {
      return widgets.resolver.resolveRequest(
        {
          ...context,
          resolveRequest: (widgetContext, name, target) =>
            app.resolver.resolveRequest(
              { ...widgetContext, resolveRequest: context.resolveRequest },
              name,
              target,
            ),
        },
        moduleName,
        platform,
      );
    },
  },
};
