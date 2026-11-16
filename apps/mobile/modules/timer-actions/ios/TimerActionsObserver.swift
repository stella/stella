import Foundation
import UIKit

/// Answers the Lock Screen's timer buttons in the app's own process.
///
/// A button on the timer's Live Activity runs expo-widgets' intent, which
/// iOS performs in the app, launching it in the background when it is not
/// running, and which posts the tap as a notification. JavaScript may not be
/// running yet, or may be suspended before a request it starts completes, so
/// the request is sent from here, under a background task.
final class TimerActionsObserver {
  static let shared = TimerActionsObserver()

  /// The notification expo-widgets posts for a tap on a widget or activity.
  private static let interaction = Notification.Name("onExpoWidgetsUserInteraction")
  /// `stella-timer:<action>:<timer id>`, as the activity's layout names its button.
  private static let targetPrefix = "stella-timer"
  private static let actions: Set<String> = ["pause", "resume"]

  private var observer: NSObjectProtocol?

  private init() {}

  func start() {
    guard observer == nil else {
      return
    }
    observer = NotificationCenter.default.addObserver(
      forName: Self.interaction,
      object: nil,
      queue: nil
    ) { [weak self] notification in
      self?.handle(notification)
    }
  }

  private func handle(_ notification: Notification) {
    guard
      let event = notification.userInfo?["eventData"] as? [String: Any],
      let target = event["target"] as? String
    else {
      return
    }
    let parts = target.split(separator: ":", maxSplits: 2).map(String.init)
    guard
      parts.count == 3,
      parts[0] == Self.targetPrefix,
      Self.actions.contains(parts[1]),
      UUID(uuidString: parts[2]) != nil
    else {
      return
    }
    send(action: parts[1], timerId: parts[2])
  }

  private func send(action: String, timerId: String) {
    guard
      let configuration = TimerActionsStore.load(),
      let server = URL(string: configuration.serverUrl),
      let deviceId = UUID(uuidString: configuration.deviceId)
    else {
      return
    }
    let url = server.appendingPathComponent(
      "v1/me/timer-activity-devices/\(deviceId.uuidString.lowercased())/actions"
    )
    var request = URLRequest(url: url, timeoutInterval: 20)
    request.httpMethod = "POST"
    request.setValue("Bearer \(configuration.key)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONSerialization.data(
      withJSONObject: ["timerId": timerId, "action": action]
    )

    // iOS may suspend the app as soon as the intent returns; the background
    // task keeps it running until the server has answered.
    var task = UIBackgroundTaskIdentifier.invalid
    let finish = {
      if task != .invalid {
        UIApplication.shared.endBackgroundTask(task)
        task = .invalid
      }
    }
    DispatchQueue.main.async {
      task = UIApplication.shared.beginBackgroundTask(
        withName: "stella-timer-action",
        expirationHandler: finish
      )
      URLSession.shared.dataTask(with: request) { _, _, _ in
        // The server's update to the activity carries the outcome; a refused
        // key leaves the activity as it was until the app opens.
        DispatchQueue.main.async(execute: finish)
      }.resume()
    }
  }
}
