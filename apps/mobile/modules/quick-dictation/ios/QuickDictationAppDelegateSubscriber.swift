import ExpoModulesCore
import UIKit

/// At launch, before iOS hands the app an intent or a Live Activity tap it
/// was launched in the background to answer: settles a dictation the app's
/// end cut short, and listens for the activity's Cancel button.
public class QuickDictationAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    QuickDictationSession.shared.restore()
    QuickDictationCancelObserver.shared.start()
    return true
  }
}

/// The Live Activity's Cancel button runs expo-widgets' intent in the app's
/// process, which posts the tap as a notification; its target is the one
/// the configuration names.
@MainActor
final class QuickDictationCancelObserver {
  static let shared = QuickDictationCancelObserver()

  /// The notification expo-widgets posts for a tap on a widget or activity.
  private static let interaction = Notification.Name("onExpoWidgetsUserInteraction")

  private var observer: NSObjectProtocol?

  private init() {}

  func start() {
    guard observer == nil else {
      return
    }
    observer = NotificationCenter.default.addObserver(
      forName: Self.interaction,
      object: nil,
      queue: .main
    ) { notification in
      let event = notification.userInfo?["eventData"] as? [String: Any]
      guard
        let target = event?["target"] as? String,
        target == QuickDictationStore.load()?.cancelTarget
      else {
        return
      }
      Task { @MainActor in
        await QuickDictationSession.shared.cancel()
      }
    }
  }
}
