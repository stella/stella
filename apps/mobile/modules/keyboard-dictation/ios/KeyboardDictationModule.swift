import ExpoModulesCore

/// The app's half of the stella keyboard (`keyboard-extension/`): the
/// session that keeps the microphone warm, records what the keyboard asks
/// for and keeps the text for it (`KeyboardDictationSession`).
public class KeyboardDictationModule: Module {
  public func definition() -> ModuleDefinition {
    Name("KeyboardDictation")

    Events("onCapture", "onStatus")

    OnCreate {
      let session = KeyboardDictationSession.shared
      session.onCapture = { [weak self] in
        self?.sendEvent("onCapture", [:])
      }
      session.onStatus = { [weak self] in
        self?.sendEvent("onStatus", [:])
      }
    }

    Function("configure") { (group: String) -> Bool in
      KeyboardDictationSession.shared.configure(group: group)
    }

    Function("setKeepWarm") { (seconds: Int) -> Bool in
      KeyboardDictationSession.shared.setKeepWarm(seconds: seconds)
    }

    Function("setLayout") { (layout: String) -> Bool in
      guard let parsed = KeyboardLayoutChoice(rawValue: layout) else {
        return false
      }
      return KeyboardDictationSession.shared.setLayout(parsed)
    }

    Function("start") { (warmSeconds: Int, rules: ChunkRulesRecord) -> String in
      KeyboardDictationSession.shared.start(
        warmSeconds: warmSeconds,
        rules: KeyboardChunkRules(
          minimumMs: Int64(rules.minimumMs), maximumMs: Int64(rules.maximumMs),
          silenceDb: Float(rules.silenceDb), pauseMs: Int64(rules.pauseMs),
          totalMaxMs: Int64(rules.totalMaxMs))
      ).rawValue
    }

    Function("end") {
      KeyboardDictationSession.shared.end()
    }

    Function("startCapture") { (jobId: String, language: String) -> Bool in
      KeyboardDictationSession.shared.startCapture(jobId: jobId, language: language)
    }

    Function("stopCapture") { (jobId: String) -> Bool in
      KeyboardDictationSession.shared.stopCapture(jobId: jobId)
    }

    Function("cancelCapture") { (jobId: String) -> Bool in
      KeyboardDictationSession.shared.cancelCapture(jobId: jobId)
    }

    Function("deliver") { (jobId: String, outcome: String, text: String?) -> Bool in
      guard let parsed = KeyboardOutcome(rawValue: outcome) else {
        return false
      }
      return KeyboardDictationSession.shared.deliver(jobId: jobId, outcome: parsed, text: text)
    }

    Function("takeCaptures") { () -> [[String: Any]] in
      KeyboardDictationSession.shared.takeCaptures()
    }

    Function("status") { () -> [String: Any] in
      KeyboardDictationSession.shared.status()
    }
  }
}

struct ChunkRulesRecord: Record {
  @Field var minimumMs: Double = 0
  @Field var maximumMs: Double = 0
  @Field var silenceDb: Double = 0
  @Field var pauseMs: Double = 0
  @Field var totalMaxMs: Double = 0
}
