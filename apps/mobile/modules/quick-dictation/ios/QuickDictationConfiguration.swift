import Foundation

/// How a dictation is cut into pieces and how long it may run, as the app's
/// `state/dictation-chunks` sets them for its own microphone.
struct QuickDictationRules: Codable {
  /// No cut before a piece has run this long.
  let minimumMs: Double
  /// A piece is cut by then, whatever is said.
  let maximumMs: Double
  /// Quieter than this, in dBFS as the recorder meters, is a pause.
  let silenceDb: Double
  /// A pause this long is between words, not inside one.
  let pauseMs: Double
  /// The longest whole dictation.
  let totalMaxMs: Double
  /// How long a finished dictation waits for the app before it is deleted.
  let keepMs: Double
}

/// What the app hands over at sign-in, so a dictation can start while the
/// app's JavaScript is not running: the Live Activity's name and its two
/// faces (recording and ready, as the layout's props), the Cancel button's
/// target, and the rules above. Present only while someone is signed in.
struct QuickDictationConfiguration {
  let activityName: String
  let cancelTarget: String
  let recording: [String: Any]
  let ready: [String: Any]
  let rules: QuickDictationRules

  static func parse(_ data: Data) -> QuickDictationConfiguration? {
    guard
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let activityName = object["activityName"] as? String,
      let cancelTarget = object["cancelTarget"] as? String,
      let recording = object["recording"] as? [String: Any],
      let ready = object["ready"] as? [String: Any],
      let rulesObject = object["rules"],
      let rulesData = try? JSONSerialization.data(withJSONObject: rulesObject),
      let rules = try? JSONDecoder().decode(QuickDictationRules.self, from: rulesData)
    else {
      return nil
    }
    return QuickDictationConfiguration(
      activityName: activityName,
      cancelTarget: cancelTarget,
      recording: recording,
      ready: ready,
      rules: rules
    )
  }
}

/// The configuration, in the app's own defaults: labels and timings, no
/// secret. Removed at sign-out, which is how a press knows no one is signed in.
enum QuickDictationStore {
  private static let key = "app.stll.quick-dictation.configuration"

  static func save(_ data: Data) -> Bool {
    guard QuickDictationConfiguration.parse(data) != nil else {
      return false
    }
    UserDefaults.standard.set(data, forKey: key)
    return true
  }

  static func load() -> QuickDictationConfiguration? {
    UserDefaults.standard.data(forKey: key).flatMap(QuickDictationConfiguration.parse)
  }

  static func clear() {
    UserDefaults.standard.removeObject(forKey: key)
  }
}
