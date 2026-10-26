import { panic } from "better-result";
import { withAppDelegate, withInfoPlist } from "expo/config-plugins";
import type { ConfigPlugin } from "expo/config-plugins";

// Named by path in app.config.ts's plugins, never applied inline there: the
// native fingerprint hashes plugin files, not the config file itself, so an
// inline plugin could change the native shell without moving it.

/** The window and React Native start that the scene delegate takes over. */
const APP_DELEGATE_WINDOW = `#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif
`;

const APP_DELEGATE_CLASS = "class AppDelegate: ExpoAppDelegate {";

/**
 * Adopts the scene life cycle, which iOS 27 asserts at launch: Expo's
 * `ExpoAppSceneDelegate` creates the window and starts React Native, and the
 * app delegate only builds the factory it hands over. The template's app
 * delegate is edited by exact text, so a template that moves either anchor
 * fails the prebuild instead of shipping an app that cannot launch.
 */
const withSceneLifecycle: ConfigPlugin = (config) =>
  withAppDelegate(
    withInfoPlist(config, (mod) => {
      mod.modResults["UIApplicationSceneManifest"] = {
        UIApplicationSupportsMultipleScenes: false,
        UISceneConfigurations: {
          UIWindowSceneSessionRoleApplication: [
            {
              UISceneConfigurationName: "Default Configuration",
              UISceneDelegateClassName: "EXExpoAppSceneDelegate",
            },
          ],
        },
      };
      return mod;
    }),
    (mod) => {
      const { contents } = mod.modResults;
      if (
        !contents.includes(APP_DELEGATE_CLASS) ||
        !contents.includes(APP_DELEGATE_WINDOW)
      ) {
        return panic(
          "The app delegate template changed; update withSceneLifecycle",
        );
      }
      mod.modResults.contents = contents
        .replace(
          APP_DELEGATE_CLASS,
          "class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {",
        )
        .replace(APP_DELEGATE_WINDOW, "");
      return mod;
    },
  );

export default withSceneLifecycle;
