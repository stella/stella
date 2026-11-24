import AVFoundation
import Foundation

/// How a long dictation is cut into pieces, each short enough for one
/// transcription: the app's own rules (`state/dictation-chunks.ts`), handed
/// over at the session's start.
struct KeyboardChunkRules {
  let minimumMs: Int64
  let maximumMs: Int64
  let silenceDb: Float
  let pauseMs: Int64
  let totalMaxMs: Int64
}

/// One recorded piece of a keyboard dictation, waiting for JavaScript to
/// transcribe it. The last piece of a dictation may hold no audio, when the
/// person stopped right after a cut.
struct KeyboardCapturePiece {
  let jobId: String
  let index: Int
  let uri: String?
  let language: String
  let durationMs: Int64
  let last: Bool

  var dictionary: [String: Any] {
    var value: [String: Any] = [
      "jobId": jobId, "index": index, "language": language,
      "durationMs": durationMs, "last": last,
    ]
    if let uri {
      value["uri"] = uri
    }
    return value
  }
}

enum KeyboardSessionStart: String {
  case started
  case denied
  case failed
}

/// The keyboard's microphone, kept open by the app. While the session runs,
/// the audio engine listens and drops what it hears, which keeps the app
/// running in the background, so a tap on the keyboard's microphone starts
/// a recording at once. Only between a start and a stop is audio written,
/// to pieces cut at pauses; each piece goes to JavaScript, which transcribes
/// it through stella and hands the text back. A session with nothing under
/// way closes when its warm time runs out.
///
/// Everything but the audio callback runs on `queue`; the callback and the
/// writer it feeds share `writerLock`.
final class KeyboardDictationSession {
  static let shared = KeyboardDictationSession()

  /// Pieces are waiting in `takeCaptures`.
  var onCapture: (() -> Void)?
  /// The session's state changed.
  var onStatus: (() -> Void)?

  /// A session started for one dictation stays this long before it starts.
  private static let oneShotGraceMs: Int64 = 30_000
  /// A command older than this is not acted on.
  private static let staleCommandMs: Int64 = 30_000
  /// An interrupted recording shorter than this held no words.
  private static let shortestKeptMs: Int64 = 300

  private let queue = DispatchQueue(label: "app.stll.keyboard-dictation")
  private let writerLock = NSLock()

  private var store: KeyboardDictationStore?
  private var engine: AVAudioEngine?
  private var format: AVAudioFormat?
  private var timer: DispatchSourceTimer?
  private var observers: [NSObjectProtocol] = []
  private var observedGroup: String?

  private var active = false
  private var warmMs: Int64 = 0
  private var warmUntil: Int64 = 0
  private var rules: KeyboardChunkRules?
  private var capture: (jobId: String, startedAt: Int64)?
  private var transcribing: [String] = []
  private var cancelled: Set<String> = []
  private var handledCommands: Set<String> = []
  private var pending: [KeyboardCapturePiece] = []

  /// Guarded by `writerLock`.
  private var writer: KeyboardCaptureWriter?
  /// Pieces the audio thread cut and `handOver` has yet to receive, in
  /// spoken order. Guarded by `writerLock`.
  private var cut: [KeyboardCapturePiece] = []

  private init() {}

  func configure(group: String) -> Bool {
    queue.sync {
      if store?.group != group {
        store = KeyboardDictationStore(group: group)
      }
      return store != nil
    }
  }

  func setKeepWarm(seconds: Int) -> Bool {
    queue.sync {
      guard let store else {
        return false
      }
      store.write(seconds, KeyboardDictationBridge.keepWarmKey)
      if active {
        warmMs = Int64(seconds) * 1000
        let now = KeyboardDictationBridge.now()
        warmUntil = now + warmMs
        publish(notify: true)
      }
      return true
    }
  }

  /// The letters the keyboard types, read by it as it next appears.
  func setLayout(_ layout: KeyboardLayoutChoice) -> Bool {
    queue.sync {
      guard let store else {
        return false
      }
      store.write(layout.rawValue, KeyboardDictationBridge.layoutKey)
      return true
    }
  }

  func start(warmSeconds: Int, rules: KeyboardChunkRules) -> KeyboardSessionStart {
    queue.sync {
      guard let store else {
        return .failed
      }
      guard Self.recordingAllowed() else {
        return .denied
      }
      self.rules = rules
      warmMs = Int64(warmSeconds) * 1000
      if !active {
        do {
          try startEngine()
        } catch {
          stopEngine(deactivate: true)
          return .failed
        }
        active = true
        // Commands sent before this session are not for it.
        handledCommands = Set(store.commands.map(\.id))
        observeCommands(group: store.group)
        startTimer()
      }
      let now = KeyboardDictationBridge.now()
      warmUntil = max(warmUntil, now + max(warmMs, Self.oneShotGraceMs))
      publish(notify: true)
      return .started
    }
  }

  /// Closes the session and forgets every dictation under way and the
  /// text the keyboard has not inserted yet: the person turned the
  /// microphone off or signed out. A transcription still running is
  /// refused when it delivers, and pieces not yet taken are deleted unread.
  func end() {
    queue.sync {
      endSession()
      for jobId in transcribing {
        cancelled.insert(jobId)
      }
      transcribing.removeAll()
      for piece in pending {
        cancelled.insert(piece.jobId)
        Self.remove(piece.uri)
      }
      pending.removeAll()
      store?.remove(KeyboardDictationBridge.resultsKey)
      publish(notify: true)
    }
  }

  /// Whether the keyboard left this dictation in the App Group within the
  /// handoff window; a match is consumed, so it is claimed once.
  func claimHandoff(jobId: String, language: String) -> Bool {
    queue.sync {
      guard let store,
        let handoff = store.read(KeyboardHandoff.self, KeyboardDictationBridge.handoffKey),
        handoff.jobId == jobId, handoff.language == language
      else {
        return false
      }
      store.remove(KeyboardDictationBridge.handoffKey)
      let age = KeyboardDictationBridge.now() - handoff.sentAt
      return age >= 0 && age <= KeyboardDictationBridge.handoffWindowMs
    }
  }

  func startCapture(jobId: String, language: String) -> Bool {
    queue.sync { beginCapture(jobId: jobId, language: language) }
  }

  func stopCapture(jobId: String) -> Bool {
    queue.sync { finishCapture(jobId: jobId) }
  }

  func cancelCapture(jobId: String) -> Bool {
    queue.sync { dropCapture(jobId: jobId) }
  }

  /// The dictation's outcome, for the keyboard to insert or offer. False
  /// when the person cancelled it meanwhile; nothing is kept then.
  func deliver(jobId: String, outcome: KeyboardOutcome, text: String?) -> Bool {
    queue.sync {
      transcribing.removeAll { $0 == jobId }
      if cancelled.remove(jobId) != nil {
        publish(notify: true)
        return false
      }
      guard let store else {
        return false
      }
      let now = KeyboardDictationBridge.now()
      let result = KeyboardResult(jobId: jobId, outcome: outcome, text: text, finishedAt: now)
      let kept = keptResults(store: store, now: now) + [result]
      store.write(
        Array(kept.suffix(KeyboardDictationBridge.keptResults)), KeyboardDictationBridge.resultsKey)
      if active {
        warmUntil = warmMs == 0 ? now : max(warmUntil, now + warmMs)
      }
      publish(notify: true)
      return true
    }
  }

  func takeCaptures() -> [[String: Any]] {
    queue.sync {
      let taken = pending
      pending = []
      return taken.map(\.dictionary)
    }
  }

  func status() -> [String: Any] {
    queue.sync {
      var value: [String: Any] = [
        "active": active,
        "phase": phase.rawValue,
        "keepWarmSeconds": store?.read(Int.self, KeyboardDictationBridge.keepWarmKey) ?? 0,
      ]
      if let layout = store?.read(String.self, KeyboardDictationBridge.layoutKey) {
        value["layout"] = layout
      }
      if active {
        value["warmUntil"] = warmUntil
      }
      if let jobId = currentJob {
        value["jobId"] = jobId
      }
      if let seen = store?.read(Int64.self, KeyboardDictationBridge.keyboardSeenKey) {
        value["keyboardSeenAt"] = seen
      }
      return value
    }
  }

  // MARK: - On the queue

  private var phase: KeyboardPhase {
    if capture != nil {
      return .recording
    }
    return transcribing.isEmpty ? .ready : .transcribing
  }

  private var currentJob: String? {
    capture?.jobId ?? transcribing.first
  }

  private func beginCapture(jobId: String, language: String) -> Bool {
    guard active, capture == nil, let format, let rules,
      UUID(uuidString: jobId) != nil,
      KeyboardDictationBridge.languages.contains(language)
    else {
      return false
    }
    let folder = FileManager.default.temporaryDirectory
      .appendingPathComponent("KeyboardDictation", isDirectory: true)
    guard
      (try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)) != nil,
      let created = try? KeyboardCaptureWriter(
        jobId: jobId, language: language, folder: folder, format: format, rules: rules)
    else {
      return false
    }
    writerLock.withLock { writer = created }
    capture = (jobId, KeyboardDictationBridge.now())
    publish(notify: true)
    return true
  }

  private func finishCapture(jobId: String) -> Bool {
    guard capture?.jobId == jobId else {
      return false
    }
    // The pieces cut before the stop go first, so the last piece never
    // overtakes one still on its way. No last piece when the writer ended
    // by itself at the dictation's limit: it is then among the cut ones.
    let pieces = writerLock.withLock { () -> [KeyboardCapturePiece] in
      var pieces = cut
      cut = []
      if let last = writer?.finish() {
        pieces.append(last)
      }
      writer = nil
      return pieces
    }
    if !pieces.isEmpty {
      handOver(pieces)
    }
    return true
  }

  private func dropCapture(jobId: String) -> Bool {
    if capture?.jobId == jobId {
      writerLock.withLock {
        writer?.discard()
        writer = nil
      }
      capture = nil
      cancelled.insert(jobId)
    } else if transcribing.contains(jobId) {
      transcribing.removeAll { $0 == jobId }
      cancelled.insert(jobId)
    } else {
      return false
    }
    // Pieces JavaScript has not taken yet are deleted unread.
    for piece in pending where piece.jobId == jobId {
      Self.remove(piece.uri)
    }
    pending.removeAll { $0.jobId == jobId }
    publish(notify: true)
    return true
  }

  private func handOver(_ pieces: [KeyboardCapturePiece]) {
    for piece in pieces {
      if cancelled.contains(piece.jobId) {
        Self.remove(piece.uri)
        continue
      }
      pending.append(piece)
      if piece.last, capture?.jobId == piece.jobId {
        capture = nil
        transcribing.append(piece.jobId)
      }
    }
    publish(notify: true)
    DispatchQueue.main.async { [weak self] in self?.onCapture?() }
  }

  private func endSession() {
    guard active else {
      return
    }
    active = false
    timer?.cancel()
    timer = nil
    stopObservingCommands()
    if let jobId = capture?.jobId {
      _ = dropCapture(jobId: jobId)
    }
    stopEngine(deactivate: true)
    warmUntil = 0
    // Text already inserted, or past its offer, is not kept beyond the session.
    if let store {
      store.write(
        keptResults(store: store, now: KeyboardDictationBridge.now()),
        KeyboardDictationBridge.resultsKey)
    }
    publish(notify: true)
  }

  private func tick() {
    guard active else {
      return
    }
    let now = KeyboardDictationBridge.now()
    if phase == .ready, now >= warmUntil {
      endSession()
      return
    }
    publish(notify: false)
  }

  private func handleCommands() {
    guard active, let store else {
      return
    }
    let now = KeyboardDictationBridge.now()
    let commands = store.commands.sorted { $0.sentAt < $1.sentAt }
    for command in commands where !handledCommands.contains(command.id) {
      handledCommands.insert(command.id)
      guard now - command.sentAt < Self.staleCommandMs else {
        continue
      }
      switch command.kind {
      case .start:
        _ = beginCapture(jobId: command.jobId, language: command.language)
      case .stop:
        _ = finishCapture(jobId: command.jobId)
      case .cancel:
        _ = dropCapture(jobId: command.jobId)
      }
    }
    // The keyboard keeps only its latest commands; so does this.
    handledCommands.formIntersection(commands.map(\.id))
  }

  private func publish(notify: Bool) {
    guard let store else {
      return
    }
    let now = KeyboardDictationBridge.now()
    store.write(
      KeyboardSnapshot(
        phase: phase,
        heartbeatAt: active ? now : 0,
        warmUntil: active ? warmUntil : 0,
        jobId: currentJob,
        recordingStartedAt: capture?.startedAt),
      KeyboardDictationBridge.snapshotKey)
    if notify {
      KeyboardDictationBridge.post(KeyboardDictationBridge.snapshotNotification(group: store.group))
      DispatchQueue.main.async { [weak self] in self?.onStatus?() }
    }
  }

  /// The results the keyboard has yet to read: not taken, not expired.
  private func keptResults(store: KeyboardDictationStore, now: Int64) -> [KeyboardResult] {
    let taken = Set(store.inserted)
    return store.results.filter {
      now - $0.finishedAt < KeyboardDictationBridge.resultLifetimeMs && !taken.contains($0.jobId)
    }
  }

  private func startTimer() {
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + 1, repeating: 1)
    timer.setEventHandler { [weak self] in self?.tick() }
    timer.resume()
    self.timer = timer
  }

  // MARK: - Audio

  private static func recordingAllowed() -> Bool {
    if #available(iOS 17.0, *) {
      return AVAudioApplication.shared.recordPermission == .granted
    }
    return AVAudioSession.sharedInstance().recordPermission == .granted
  }

  private func startEngine() throws {
    let session = AVAudioSession.sharedInstance()
    // Mixed with what else plays, from the phone's own microphone, so music
    // in headphones keeps playing and a headset never switches to call audio.
    try session.setCategory(
      .playAndRecord, mode: .default,
      options: [.mixWithOthers, .allowBluetoothA2DP, .defaultToSpeaker])
    if let builtIn = session.availableInputs?.first(where: { $0.portType == .builtInMic }) {
      try? session.setPreferredInput(builtIn)
    }
    try session.setActive(true)
    let engine = AVAudioEngine()
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      throw KeyboardDictationError.noInput
    }
    input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
      self?.receive(buffer)
    }
    engine.prepare()
    try engine.start()
    self.engine = engine
    self.format = format
    observeAudio(engine: engine)
  }

  /// Leaves the audio session active unless asked, so a restart in the
  /// background may still record: iOS lets an app start recording there
  /// only while its session stays active.
  private func stopEngine(deactivate: Bool) {
    for observer in observers {
      NotificationCenter.default.removeObserver(observer)
    }
    observers = []
    engine?.inputNode.removeTap(onBus: 0)
    engine?.stop()
    engine = nil
    format = nil
    if deactivate {
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
  }

  /// On the audio thread: writes the buffer while a dictation records.
  private func receive(_ buffer: AVAudioPCMBuffer) {
    let wasCut = writerLock.withLock { () -> Bool in
      guard let current = writer else {
        return false
      }
      let pieces = current.append(buffer)
      if pieces.contains(where: \.last) {
        writer = nil
      }
      cut.append(contentsOf: pieces)
      return !pieces.isEmpty
    }
    if wasCut {
      queue.async { [weak self] in self?.handOverCut() }
    }
  }

  /// On the queue: hands over what the audio thread cut, unless a stop
  /// already took it along.
  private func handOverCut() {
    let pieces = writerLock.withLock { () -> [KeyboardCapturePiece] in
      let pieces = cut
      cut = []
      return pieces
    }
    if !pieces.isEmpty {
      handOver(pieces)
    }
  }

  private func observeAudio(engine: AVAudioEngine) {
    let center = NotificationCenter.default
    observers = [
      center.addObserver(
        forName: AVAudioSession.interruptionNotification, object: nil, queue: nil
      ) { [weak self] notification in
        let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
        let options = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt
        self?.queue.async {
          self?.interrupted(
            type: raw.flatMap(AVAudioSession.InterruptionType.init(rawValue:)),
            resume: options.map { AVAudioSession.InterruptionOptions(rawValue: $0).contains(.shouldResume) }
              ?? false)
        }
      },
      // A new route (headphones in or out) stops the engine and may change
      // the input's format, so it starts again from the top.
      center.addObserver(
        forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
      ) { [weak self] _ in
        self?.queue.async { self?.restart() }
      },
    ]
  }

  /// A call or Siri takes the microphone: a recording that holds words is
  /// kept and transcribed, a mere tap is dropped, and the session goes on
  /// afterwards when iOS says it may.
  private func interrupted(type: AVAudioSession.InterruptionType?, resume: Bool) {
    guard active else {
      return
    }
    switch type {
    case .began:
      if let capture {
        if KeyboardDictationBridge.now() - capture.startedAt >= Self.shortestKeptMs {
          _ = finishCapture(jobId: capture.jobId)
        } else {
          _ = dropCapture(jobId: capture.jobId)
        }
      }
    case .ended:
      if resume, (try? AVAudioSession.sharedInstance().setActive(true)) != nil,
        (try? engine?.start()) != nil
      {
        publish(notify: true)
      } else {
        endSession()
      }
    default:
      break
    }
  }

  private func restart() {
    guard active else {
      return
    }
    if let capture {
      _ = finishCapture(jobId: capture.jobId)
    }
    stopEngine(deactivate: false)
    do {
      try startEngine()
      publish(notify: true)
    } catch {
      endSession()
    }
  }

  // MARK: - Darwin notifications

  private func observeCommands(group: String) {
    stopObservingCommands()
    CFNotificationCenterAddObserver(
      CFNotificationCenterGetDarwinNotifyCenter(),
      Unmanaged.passUnretained(self).toOpaque(),
      { _, observer, _, _, _ in
        guard let observer else {
          return
        }
        let session = Unmanaged<KeyboardDictationSession>.fromOpaque(observer).takeUnretainedValue()
        session.queue.async { session.handleCommands() }
      },
      KeyboardDictationBridge.commandNotification(group: group) as CFString,
      nil, .deliverImmediately)
    observedGroup = group
  }

  private func stopObservingCommands() {
    guard let group = observedGroup else {
      return
    }
    CFNotificationCenterRemoveObserver(
      CFNotificationCenterGetDarwinNotifyCenter(),
      Unmanaged.passUnretained(self).toOpaque(),
      CFNotificationName(KeyboardDictationBridge.commandNotification(group: group) as CFString),
      nil)
    observedGroup = nil
  }

  private static func remove(_ uri: String?) {
    guard let uri, let url = URL(string: uri) else {
      return
    }
    try? FileManager.default.removeItem(at: url)
  }
}

enum KeyboardDictationError: Error {
  case noInput
}

/// Writes one dictation's audio, a piece at a time: a piece ends at the
/// first pause once it is long enough, or just before the transcription's
/// limit, and the next buffer starts the next piece, so no audio is lost
/// between them. Used only under the session's `writerLock`.
final class KeyboardCaptureWriter {
  private let jobId: String
  private let language: String
  private let folder: URL
  private let format: AVAudioFormat
  private let rules: KeyboardChunkRules
  private var file: AVAudioFile?
  private var url: URL
  private var index = 0
  private var pieceFrames: Int64 = 0
  private var totalFrames: Int64 = 0
  private var quietSinceMs: Int64?

  init(jobId: String, language: String, folder: URL, format: AVAudioFormat, rules: KeyboardChunkRules) throws {
    self.jobId = jobId
    self.language = language
    self.folder = folder
    self.format = format
    self.rules = rules
    let opened = try Self.open(folder: folder, jobId: jobId, index: 0, format: format)
    file = opened.file
    url = opened.url
  }

  /// AAC in an MP4 container, what the transcription takes from the phone.
  private static func open(folder: URL, jobId: String, index: Int, format: AVAudioFormat) throws
    -> (file: AVAudioFile, url: URL)
  {
    let url = folder.appendingPathComponent("\(jobId.lowercased())-\(index).m4a")
    let file = try AVAudioFile(
      forWriting: url,
      settings: [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: format.sampleRate,
        AVNumberOfChannelsKey: format.channelCount,
      ],
      commonFormat: format.commonFormat, interleaved: format.isInterleaved)
    return (file, url)
  }

  private func milliseconds(_ frames: Int64) -> Int64 {
    Int64(Double(frames) * 1000 / format.sampleRate)
  }

  /// The pieces this buffer ended: none, one cut at a pause, or the last
  /// one at the dictation's limit or a failed write.
  func append(_ buffer: AVAudioPCMBuffer) -> [KeyboardCapturePiece] {
    guard let file else {
      return []
    }
    do {
      try file.write(from: buffer)
    } catch {
      return [finish()]
    }
    pieceFrames += Int64(buffer.frameLength)
    totalFrames += Int64(buffer.frameLength)
    if milliseconds(totalFrames) >= rules.totalMaxMs {
      return [finish()]
    }
    return shouldCut(level: Self.level(of: buffer)) ? [cut()] : []
  }

  /// The same rule as the composer's (`watchChunk`), read per buffer.
  private func shouldCut(level: Float?) -> Bool {
    let pieceMs = milliseconds(pieceFrames)
    if pieceMs >= rules.maximumMs {
      return true
    }
    guard let level, level < rules.silenceDb else {
      quietSinceMs = nil
      return false
    }
    let since = quietSinceMs ?? pieceMs
    quietSinceMs = since
    return pieceMs - since >= rules.pauseMs && pieceMs >= rules.minimumMs
  }

  private func cut() -> KeyboardCapturePiece {
    let done = piece(last: false)
    index += 1
    pieceFrames = 0
    quietSinceMs = nil
    do {
      let opened = try Self.open(folder: folder, jobId: jobId, index: index, format: format)
      file = opened.file
      url = opened.url
    } catch {
      // Without a next file the dictation ends here, with what it holds.
      file = nil
      return KeyboardCapturePiece(
        jobId: done.jobId, index: done.index, uri: done.uri, language: done.language,
        durationMs: done.durationMs, last: true)
    }
    return done
  }

  /// Closes the current piece as the dictation's last.
  func finish() -> KeyboardCapturePiece {
    let done = piece(last: true)
    file = nil
    return done
  }

  /// Deletes the current piece's file; pieces handed over are not here.
  func discard() {
    file = nil
    try? FileManager.default.removeItem(at: url)
  }

  /// Releasing the file closes it, so the piece is complete once handed over.
  private func piece(last: Bool) -> KeyboardCapturePiece {
    file = nil
    let empty = pieceFrames == 0
    if empty {
      try? FileManager.default.removeItem(at: url)
    }
    return KeyboardCapturePiece(
      jobId: jobId, index: index, uri: empty ? nil : url.absoluteString, language: language,
      durationMs: milliseconds(pieceFrames), last: last)
  }

  /// The buffer's loudness in dBFS, as the recorder meters it.
  private static func level(of buffer: AVAudioPCMBuffer) -> Float? {
    guard let channels = buffer.floatChannelData, buffer.frameLength > 0 else {
      return nil
    }
    let samples = channels[0]
    let count = Int(buffer.frameLength)
    var sum: Float = 0
    for index in 0..<count {
      sum += samples[index] * samples[index]
    }
    let rms = (sum / Float(count)).squareRoot()
    return rms > 0 ? 20 * log10(rms) : -160
  }
}
