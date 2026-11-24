import AVFoundation
import Foundation

/// What a press of the dictation button did.
public enum QuickDictationPress: Sendable {
  /// Recording started, with its Live Activity.
  case started
  /// Recording stopped; the app should open on the dictation.
  case finished
  /// A finished dictation still waits for the app, which should open on it.
  case waiting
  /// Nothing was recorded; the app should open, or the person be told why.
  case refused(QuickDictationRefusal)
}

public enum QuickDictationRefusal: Sendable {
  case signedOut
  /// The microphone was never asked for; only the app in front can ask.
  case microphoneUndecided
  case microphoneDenied
  case failed
}

/// Where the dictation stands, as the app reads it.
public enum QuickDictationPhase: String, Sendable {
  case idle
  case recording
  case finished
}

/// One dictation recorded outside the app's screens, started and finished by
/// an App Intent (the Action Button, Siri, Shortcuts, a Control Center
/// control) or the Live Activity's buttons.
///
/// It records as the composer's microphone does: one channel of AAC at
/// 16 kHz (`src/components/use-dictation.ts`), in pieces cut at pauses by the
/// app's rules, so each piece fits one transcription. The pieces wait in the
/// caches folder until the app takes them to transcribe and deletes them; a
/// finished dictation the app never takes is deleted after `keepMs`. One
/// dictation at a time: a press while a finished one waits opens the app on
/// it instead of recording over it.
@MainActor
public final class QuickDictationSession {
  public static let shared = QuickDictationSession()

  /// Posted at every change of phase, its `phase` the new one, so the app
  /// can open on a finished dictation.
  nonisolated static let changed = Notification.Name("app.stll.quick-dictation.changed")

  private var recording: Recording?
  private var meter: Timer?
  private var interruption: NSObjectProtocol?

  private init() {}

  public var phase: QuickDictationPhase {
    if recording != nil {
      return .recording
    }
    return Self.finishedMarker() == nil ? .idle : .finished
  }

  // MARK: Presses

  public func press() async -> QuickDictationPress {
    if recording != nil {
      await finish()
      return .finished
    }
    if Self.finishedMarker() != nil {
      return .waiting
    }
    return await start()
  }

  /// Asks for the microphone; only meaningful with the app in front.
  public func requestMicrophone() async -> Bool {
    await AVAudioApplication.requestRecordPermission()
  }

  /// Drops what is being recorded or waits, and its Live Activity.
  func cancel() async {
    stopRecording()
    Self.removeFolder()
    if let configuration = QuickDictationStore.load() {
      await QuickDictationActivity.end(name: configuration.activityName)
    }
    announce()
  }

  // MARK: The app's side

  /// The finished dictation's pieces, in spoken order, finishing a recording
  /// first; nil when there is none. They stay until `discard`, so a
  /// transcription that fails can be tried again.
  func take() async -> [URL]? {
    if recording != nil {
      await finish()
    }
    guard Self.finishedMarker() != nil else {
      return nil
    }
    if let configuration = QuickDictationStore.load() {
      await QuickDictationActivity.end(name: configuration.activityName)
    }
    return Self.pieces()
  }

  func discard() {
    if recording == nil {
      Self.removeFolder()
      announce()
    }
  }

  /// At launch: a dictation cut short by the app's end becomes a finished
  /// one, and one kept past its time is deleted.
  func restore() {
    guard recording == nil else {
      return
    }
    let now = Date()
    if let marker = Self.finishedMarker() {
      let keepMs = QuickDictationStore.load()?.rules.keepMs ?? 0
      if now.timeIntervalSince(marker.finishedAt) * 1000 > keepMs {
        Self.removeFolder()
      }
    } else if !Self.pieces().isEmpty {
      Self.writeMarker(FinishedMarker(startedAt: now, finishedAt: now))
    }
  }

  // MARK: Recording

  private func start() async -> QuickDictationPress {
    guard let configuration = QuickDictationStore.load() else {
      return .refused(.signedOut)
    }
    switch Self.microphone() {
    case .undecided:
      return .refused(.microphoneUndecided)
    case .denied:
      return .refused(.microphoneDenied)
    case .granted:
      break
    }
    let startedAt = Date()
    do {
      let audio = AVAudioSession.sharedInstance()
      try audio.setCategory(.record, mode: .default)
      try audio.setActive(true)
      Self.removeFolder()
      try FileManager.default.createDirectory(at: Self.folder, withIntermediateDirectories: true)
      let recorder = try Self.recordPiece(index: 0)
      recording = Recording(
        configuration: configuration,
        startedAt: startedAt,
        recorder: recorder
      )
    } catch {
      Self.releaseMicrophone()
      Self.removeFolder()
      return .refused(.failed)
    }
    watchInterruptions()
    meter = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in
      Task { @MainActor in
        QuickDictationSession.shared.read()
      }
    }
    await QuickDictationActivity.show(
      face: configuration.recording,
      startedAt: startedAt,
      staleDate: startedAt.addingTimeInterval(configuration.rules.totalMaxMs / 1000 + 60),
      name: configuration.activityName
    )
    announce()
    return .started
  }

  /// One reading of the recorder: ends the dictation at its limit and cuts
  /// the piece at a pause, as `watchChunk` in `state/dictation-chunks` does.
  private func read() {
    guard let current = recording else {
      return
    }
    let rules = current.configuration.rules
    current.recorder.updateMeters()
    let pieceMs = current.recorder.currentTime * 1000
    if current.doneMs + pieceMs >= rules.totalMaxMs {
      Task {
        await finish()
      }
      return
    }
    if pieceMs >= rules.maximumMs {
      cut(current, pieceMs: pieceMs)
      return
    }
    let level = Double(current.recorder.averagePower(forChannel: 0))
    guard level < rules.silenceDb else {
      current.quietSinceMs = nil
      return
    }
    let quietSinceMs = current.quietSinceMs ?? pieceMs
    current.quietSinceMs = quietSinceMs
    if pieceMs - quietSinceMs >= rules.pauseMs && pieceMs >= rules.minimumMs {
      cut(current, pieceMs: pieceMs)
    }
  }

  /// Ends the piece and records the next at once; a next piece that cannot
  /// start finishes the dictation with what it has.
  private func cut(_ current: Recording, pieceMs: Double) {
    current.recorder.stop()
    current.doneMs += pieceMs
    current.quietSinceMs = nil
    current.pieceIndex += 1
    do {
      current.recorder = try Self.recordPiece(index: current.pieceIndex)
    } catch {
      Task {
        await finish()
      }
    }
  }

  private func finish() async {
    guard let current = recording else {
      return
    }
    stopRecording()
    let finishedAt = Date()
    Self.writeMarker(FinishedMarker(startedAt: current.startedAt, finishedAt: finishedAt))
    await QuickDictationActivity.show(
      face: current.configuration.ready,
      startedAt: current.startedAt,
      staleDate: finishedAt.addingTimeInterval(current.configuration.rules.keepMs / 1000),
      name: current.configuration.activityName
    )
    announce()
  }

  private func announce() {
    NotificationCenter.default.post(
      name: Self.changed,
      object: nil,
      userInfo: ["phase": phase.rawValue]
    )
  }

  private func stopRecording() {
    meter?.invalidate()
    meter = nil
    if let interruption {
      NotificationCenter.default.removeObserver(interruption)
    }
    interruption = nil
    recording?.recorder.stop()
    recording = nil
    Self.releaseMicrophone()
  }

  /// A call or another app taking the microphone ends the dictation with
  /// what was said so far.
  private func watchInterruptions() {
    interruption = NotificationCenter.default.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: AVAudioSession.sharedInstance(),
      queue: .main
    ) { notification in
      let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
      guard raw == AVAudioSession.InterruptionType.began.rawValue else {
        return
      }
      Task { @MainActor in
        await QuickDictationSession.shared.finish()
      }
    }
  }

  // MARK: Files

  private final class Recording {
    let configuration: QuickDictationConfiguration
    let startedAt: Date
    var recorder: AVAudioRecorder
    var pieceIndex = 0
    /// How long the finished pieces ran.
    var doneMs: Double = 0
    var quietSinceMs: Double?

    init(configuration: QuickDictationConfiguration, startedAt: Date, recorder: AVAudioRecorder) {
      self.configuration = configuration
      self.startedAt = startedAt
      self.recorder = recorder
    }
  }

  private struct FinishedMarker: Codable {
    let startedAt: Date
    let finishedAt: Date
  }

  private enum MicrophoneAccess {
    case granted
    case denied
    case undecided
  }

  private static let settings: [String: Any] = [
    AVFormatIDKey: kAudioFormatMPEG4AAC,
    AVSampleRateKey: 16_000,
    AVNumberOfChannelsKey: 1,
    AVEncoderBitRateKey: 32_000,
    AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
  ]

  private static var folder: URL {
    FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("QuickDictation", isDirectory: true)
  }

  private static var marker: URL {
    folder.appendingPathComponent("finished.json")
  }

  private static func recordPiece(index: Int) throws -> AVAudioRecorder {
    let url = folder.appendingPathComponent(String(format: "piece-%03d.m4a", index))
    let recorder = try AVAudioRecorder(url: url, settings: settings)
    recorder.isMeteringEnabled = true
    guard recorder.record() else {
      throw CocoaError(.fileWriteUnknown)
    }
    return recorder
  }

  /// The pieces, in spoken order: their names sort as they were recorded.
  private static func pieces() -> [URL] {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
    return names
      .filter { $0.hasPrefix("piece-") && $0.hasSuffix(".m4a") }
      .sorted()
      .map { folder.appendingPathComponent($0) }
  }

  private static func finishedMarker() -> FinishedMarker? {
    guard let data = try? Data(contentsOf: marker) else {
      return nil
    }
    return try? JSONDecoder().decode(FinishedMarker.self, from: data)
  }

  private static func writeMarker(_ value: FinishedMarker) {
    if let data = try? JSONEncoder().encode(value) {
      try? data.write(to: marker, options: .atomic)
    }
  }

  private static func removeFolder() {
    try? FileManager.default.removeItem(at: folder)
  }

  private static func microphone() -> MicrophoneAccess {
    switch AVAudioApplication.shared.recordPermission {
    case .granted:
      return .granted
    case .undetermined:
      return .undecided
    default:
      return .denied
    }
  }

  /// Gives the microphone back, so other apps' audio resumes.
  private static func releaseMicrophone() {
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
}
