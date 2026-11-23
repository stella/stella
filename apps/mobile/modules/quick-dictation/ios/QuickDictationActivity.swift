import ActivityKit
import Foundation

/// expo-widgets' activity attributes, declared again here: its own are
/// internal to its module, and a dictation's activity must start while the
/// app's JavaScript may not be running. ActivityKit pairs the app's request
/// with the widget extension's `ActivityConfiguration` by the type's name and
/// its encoded shape, so both must match expo-widgets'
/// `ios/Widgets/WidgetLiveActivity.swift` exactly
/// (`scripts/quick-dictation.test.ts` compares them).
struct LiveActivityAttributes: ActivityAttributes {
  var url: String?

  public struct ContentState: Codable, Hashable {
    var name: String
    var props: String?
  }

  init(url: String? = nil) {
    self.url = url
  }
}

/// The dictation's Live Activity: started, changed and ended from native
/// code, drawn by the layout the app registered under the configuration's
/// name (`src/widgets/dictation-activity.ios.tsx`). On the main actor with
/// the session that drives it.
@MainActor
enum QuickDictationActivity {
  /// The layout prop the activity's clock counts from, set on both faces.
  static let clockProp = "startedAtMs"

  /// Shows `face` with the clock set, starting the activity when none is
  /// shown. Best effort: with Live Activities off the recording still runs.
  static func show(
    face: [String: Any],
    startedAt: Date,
    staleDate: Date?,
    name: String
  ) async {
    var props = face
    props[clockProp] = (startedAt.timeIntervalSince1970 * 1000).rounded()
    guard
      let data = try? JSONSerialization.data(withJSONObject: props),
      let json = String(data: data, encoding: .utf8)
    else {
      return
    }
    let content = ActivityContent(
      state: LiveActivityAttributes.ContentState(name: name, props: json),
      staleDate: staleDate
    )
    if let shown = activities(named: name).first {
      await shown.update(content)
      return
    }
    guard ActivityAuthorizationInfo().areActivitiesEnabled else {
      return
    }
    _ = try? Activity.request(
      attributes: LiveActivityAttributes(),
      content: content,
      pushType: nil
    )
  }

  static func end(name: String) async {
    for activity in activities(named: name) {
      await activity.end(nil, dismissalPolicy: .immediate)
    }
  }

  private static func activities(named name: String) -> [Activity<LiveActivityAttributes>] {
    Activity<LiveActivityAttributes>.activities.filter { $0.content.state.name == name }
  }
}
