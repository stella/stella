import ExpoModulesCore

/// Lets the app hand the native side the key its Lock Screen buttons act
/// with, and take it back at sign-out.
public class TimerActionsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("TimerActions")

    Function("configure") { (serverUrl: String, deviceId: String, key: String) -> Bool in
      TimerActionsStore.save(
        TimerActionsConfiguration(serverUrl: serverUrl, deviceId: deviceId, key: key)
      )
    }

    Function("clear") {
      TimerActionsStore.clear()
    }
  }
}
