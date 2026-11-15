import ExpoModulesCore
import UIKit

/// Starts listening for the Lock Screen's timer buttons as the app launches,
/// before iOS hands it a tap it was launched in the background to answer.
public class TimerActionsAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    TimerActionsObserver.shared.start()
    return true
  }
}
