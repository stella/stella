import Foundation

// What the stella keyboard and the app say to each other. A keyboard may not
// record, so the app records and transcribes; the two share the App Group's
// defaults and wake each other with Darwin notifications, which carry no
// data. Every key has one writer: the keyboard writes commands, the language
// it dictates in, the results it inserted, when it last ran and the handoff
// it opens the app with (which the app removes once it takes it); the app
// writes its state, with a heartbeat, and the results. The prebuild copies
// this file into the keyboard's target, so both sides compile the same one.
//
// Times are milliseconds since 1970: both processes read the same clock.

enum KeyboardDictationBridge {
  static let commandsKey = "keyboardDictation.commands"
  static let snapshotKey = "keyboardDictation.snapshot"
  static let resultsKey = "keyboardDictation.results"
  static let insertedKey = "keyboardDictation.inserted"
  static let languageKey = "keyboardDictation.language"
  static let keyboardSeenKey = "keyboardDictation.keyboardSeenAt"
  static let keepWarmKey = "keyboardDictation.keepWarmSeconds"
  /// The letter layout picked in the app's settings; the app writes it.
  static let layoutKey = "keyboardDictation.layout"
  /// The dictation the keyboard opens the app to record. The app records
  /// only a link that matches it, so no other app's link starts a recording.
  static let handoffKey = "keyboardDictation.handoff"

  /// The languages the keyboard's language key offers, `auto` first: the
  /// transcription then hears which one is spoken. Pinned to the app's list
  /// (`src/keyboard/keyboard-protocol.ts`) by its test.
  static let languages = ["auto", "cs", "sk", "en", "de", "pl"]

  /// A link from the keyboard older than this only opens the app: it never
  /// starts a recording the person no longer expects.
  static let handoffWindowMs: Int64 = 10_000
  /// The app writes its heartbeat every second; a fresher one than this
  /// means the microphone is warm.
  static let warmHeartbeatMs: Int64 = 3_000
  /// No heartbeat for this long while a dictation is under way: the app
  /// was stopped, and the keyboard says so.
  static let stalledAfterMs: Int64 = 6_000
  /// A result the keyboard has not inserted stays offered this long.
  static let resultLifetimeMs: Int64 = 10 * 60 * 1000
  /// The keyboard keeps its latest commands, so two sent in quick
  /// succession are both read.
  static let keptCommands = 8
  static let keptResults = 10
  static let keptInserted = 20

  static func commandNotification(group: String) -> String {
    "\(group).keyboardDictation.command"
  }

  static func snapshotNotification(group: String) -> String {
    "\(group).keyboardDictation.snapshot"
  }

  static func now() -> Int64 {
    Int64(Date().timeIntervalSince1970 * 1000)
  }

  /// Wakes the other side; it reads what changed from the defaults.
  static func post(_ name: String) {
    CFNotificationCenterPostNotification(
      CFNotificationCenterGetDarwinNotifyCenter(),
      CFNotificationName(name as CFString), nil, nil, true)
  }
}

/// The letters the keyboard types, as Settings › stella keyboard offers
/// them. Pinned to the app's list (`src/state/keyboard-dictation.ts`) by its
/// test.
enum KeyboardLayoutChoice: String, Codable, CaseIterable {
  case qwertz
  case qwerty
}

enum KeyboardCommandKind: String, Codable {
  case start
  case stop
  case cancel
}

/// What the keyboard leaves in the App Group as it opens the app to record.
struct KeyboardHandoff: Codable, Equatable {
  let jobId: String
  let language: String
  let sentAt: Int64
}

struct KeyboardCommand: Codable, Equatable {
  let id: String
  let kind: KeyboardCommandKind
  let jobId: String
  let language: String
  let sentAt: Int64
}

enum KeyboardPhase: String, Codable {
  case ready
  case recording
  case transcribing
}

/// The app's state as the keyboard reads it. While the microphone is warm
/// the app rewrites it every second.
struct KeyboardSnapshot: Codable {
  let phase: KeyboardPhase
  let heartbeatAt: Int64
  /// When a session with nothing under way closes.
  let warmUntil: Int64
  /// The dictation recording or being transcribed.
  let jobId: String?
  let recordingStartedAt: Int64?

  func isLive(at now: Int64) -> Bool {
    now - heartbeatAt < KeyboardDictationBridge.stalledAfterMs
  }

  /// Whether a tap may start a dictation without opening the app.
  func isWarm(at now: Int64) -> Bool {
    now - heartbeatAt < KeyboardDictationBridge.warmHeartbeatMs
      && (phase != .ready || warmUntil > now)
  }
}

enum KeyboardOutcome: String, Codable {
  case text
  case silent
  case failed
}

struct KeyboardResult: Codable {
  let jobId: String
  let outcome: KeyboardOutcome
  let text: String?
  let finishedAt: Int64

  func isOffered(at now: Int64) -> Bool {
    outcome == .text && text?.isEmpty == false
      && now - finishedAt < KeyboardDictationBridge.resultLifetimeMs
  }
}

/// The App Group's defaults, read and written as JSON.
struct KeyboardDictationStore {
  let group: String
  private let defaults: UserDefaults

  init?(group: String) {
    guard !group.isEmpty, let defaults = UserDefaults(suiteName: group) else {
      return nil
    }
    self.group = group
    self.defaults = defaults
  }

  func read<Value: Decodable>(_ type: Value.Type, _ key: String) -> Value? {
    guard let data = defaults.data(forKey: key) else {
      return nil
    }
    return try? JSONDecoder().decode(type, from: data)
  }

  func write<Value: Encodable>(_ value: Value, _ key: String) {
    guard let data = try? JSONEncoder().encode(value) else {
      return
    }
    defaults.set(data, forKey: key)
  }

  func remove(_ key: String) {
    defaults.removeObject(forKey: key)
  }

  var commands: [KeyboardCommand] {
    read([KeyboardCommand].self, KeyboardDictationBridge.commandsKey) ?? []
  }

  var snapshot: KeyboardSnapshot? {
    read(KeyboardSnapshot.self, KeyboardDictationBridge.snapshotKey)
  }

  var results: [KeyboardResult] {
    read([KeyboardResult].self, KeyboardDictationBridge.resultsKey) ?? []
  }

  var inserted: [String] {
    read([String].self, KeyboardDictationBridge.insertedKey) ?? []
  }

  /// The results the keyboard has yet to insert, newest first.
  func offeredResults(at now: Int64) -> [KeyboardResult] {
    let taken = Set(inserted)
    return results
      .filter { $0.isOffered(at: now) && !taken.contains($0.jobId) }
      .sorted { $0.finishedAt > $1.finishedAt }
  }
}
