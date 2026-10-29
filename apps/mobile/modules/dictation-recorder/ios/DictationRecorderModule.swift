import AVFoundation
import CryptoKit
import ExpoModulesCore
import StellaRNNoise
import UIKit

private struct Meter: Codable {
  let timeMs: Double
  let db: Double
}

public final class DictationRecorderModule: Module {
  private var captures: [String: DurableCapture] = [:]
  private let scopeLock = NSLock()

  private func capture(_ scope: [String: String], recording: Bool = false) throws -> DurableCapture {
    let key = try DraftScope.rootKey(serverOrigin: scope["serverOrigin"] ?? "", userId: scope["userId"] ?? "")
    scopeLock.lock()
    defer { scopeLock.unlock() }
    if recording && captures.values.contains(where: { $0.isRecording }) {
      throw CaptureFailure.invalid("A recording is already active.")
    }
    if let existing = captures[key] { return existing }
    let created = DurableCapture(scopeKey: key)
    captures[key] = created
    return created
  }

  public func definition() -> ModuleDefinition {
    Name("DictationRecorder")
    AsyncFunction("listDrafts") { (scope: [String: String]) in try self.capture(scope).listDrafts() }.runOnQueue(.main)
    AsyncFunction("status") { (scope: [String: String], id: String) in try self.capture(scope).status(id) }.runOnQueue(.main)
    AsyncFunction("suspend") { (scope: [String: String]) in
      try self.capture(scope).suspend()
    }.runOnQueue(.main)
    AsyncFunction("start") { (scope: [String: String], matterId: String?, promise: Promise) in
      let capture: DurableCapture
      let epoch: CaptureRequestTicket
      do {
        capture = try self.capture(scope)
        epoch = capture.startEpoch
      } catch {
        promise.reject("ERR_DICTATION_SCOPE", error.localizedDescription)
        return
      }
      AVAudioSession.sharedInstance().requestRecordPermission { granted in
        DispatchQueue.main.async {
          guard capture.startEpoch == epoch else {
            promise.reject("ERR_DICTATION_CANCELLED", "The recording request was cancelled.")
            return
          }
          guard granted else {
            promise.reject("ERR_DICTATION_PERMISSION", "Microphone access was denied.")
            return
          }
          do {
            _ = try self.capture(scope, recording: true)
            promise.resolve(try capture.start(matterId))
          } catch { promise.reject("ERR_DICTATION_START", error.localizedDescription) }
        }
      }
    }.runOnQueue(.main)
    AsyncFunction("pause") { (scope: [String: String], id: String) in try self.capture(scope).pause(id) }.runOnQueue(.main)
    AsyncFunction("resume") { (scope: [String: String], id: String) in try self.capture(scope, recording: true).resume(id) }.runOnQueue(.main)
    AsyncFunction("finish") { (scope: [String: String], id: String) in try self.capture(scope).finish(id) }.runOnQueue(.main)
    AsyncFunction("addMarker") { (scope: [String: String], id: String) in try self.capture(scope).addMarker(id) }.runOnQueue(.main)
    AsyncFunction("deleteDraft") { (scope: [String: String], id: String) in try self.capture(scope).deleteDraft(id) }
    AsyncFunction("exportAudio") { (scope: [String: String], id: String, cleaned: Bool, promise: Promise) in
      DispatchQueue.global(qos: .utility).async {
        do { promise.resolve(try self.capture(scope).exportAudio(id, cleaned: cleaned)) }
        catch { promise.reject("ERR_DICTATION_EXPORT", error.localizedDescription) }
      }
    }
    AsyncFunction("shareAudio") { (scope: [String: String], uri: String, promise: Promise) in
      do {
        let url = try self.capture(scope).shareableURL(uri)
        guard let presenter = self.appContext?.utilities?.currentViewController() else {
          throw CaptureFailure.invalid("There is no screen to share from.")
        }
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        sheet.completionWithItemsHandler = { _, completed, _, error in
          if let error { promise.reject("ERR_DICTATION_SHARE", error.localizedDescription) }
          else { promise.resolve(completed) }
        }
        if let popover = sheet.popoverPresentationController {
          popover.sourceView = presenter.view
          popover.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 1, height: 1)
        }
        presenter.present(sheet, animated: true)
      } catch { promise.reject("ERR_DICTATION_SHARE", error.localizedDescription) }
    }.runOnQueue(.main)
  }
}

/// Raw float frames are append-only: a crash needs no container finalization.
/// AAC is derived only after stopping; exporting never mutates these frames.
private final class DurableCapture {
  private let io = DispatchQueue(label: "app.stll.dictation.io")
  private var engine = AVAudioEngine()
  private let sampleRate = DictationPCM.sampleRate
  private let bucketFrames = DictationPCM.bucketFrames
  private var active: Draft?
  private var audio: FileHandle?
  private var meters: FileHandle?
  private var recentMeters: [Meter] = []
  private var lastMeterAt: Double?
  private var recordingSince: Double?
  private var frames: Int64 = 0
  private var bucketEnergy: Double = 0
  private var bucketCount = 0
  private var captureError: String?
  private var cleaningProgress: [String: Double] = [:]
  private var interruption: NSObjectProtocol?
  private var mediaReset: NSObjectProtocol?
  private var hasTap = false
  private var requests = CaptureRequests()
  private let originalExportLock = NSLock()
  private let cleanedExportLock = NSLock()
  private let scopeKey: String

  var isRecording: Bool { io.sync { active?.status == .recording } }
  var startEpoch: CaptureRequestTicket { io.sync { requests.ticket } }

  func suspend() throws {
    let recordingID = io.sync {
      requests.invalidate()
      return active?.status == .recording ? active?.id : nil
    }
    if let recordingID { _ = try pause(recordingID) }
  }

  init(scopeKey: String) {
    self.scopeKey = scopeKey
    interruption = NotificationCenter.default.addObserver(
      forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
    ) { [weak self] notification in
      guard let self,
        let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
        AVAudioSession.InterruptionType(rawValue: raw) == .began,
        let id = self.io.sync(execute: { self.active?.status == .recording ? self.active?.id : nil })
      else { return }
      do { _ = try self.pause(id) }
      catch { self.io.sync { self.captureError = error.localizedDescription } }
    }
    mediaReset = NotificationCenter.default.addObserver(
      forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main
    ) { [weak self] _ in
      guard let self else { return }
      if let id = self.io.sync(execute: { self.active?.status == .recording ? self.active?.id : nil }) {
        do { _ = try self.pause(id) }
        catch { self.io.sync { self.captureError = error.localizedDescription } }
      }
      self.engine = AVAudioEngine()
      self.hasTap = false
    }
  }

  deinit {
    if let interruption { NotificationCenter.default.removeObserver(interruption) }
    if let mediaReset { NotificationCenter.default.removeObserver(mediaReset) }
  }

  private func root() throws -> URL {
    let parent = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let url = parent.appendingPathComponent("Dictations", isDirectory: true).appendingPathComponent(scopeKey, isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUnlessOpen])
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    var mutableURL = url
    try mutableURL.setResourceValues(values)
    return url
  }

  private func directory(_ id: String) throws -> URL {
    guard UUID(uuidString: id)?.uuidString == id else { throw CaptureFailure.invalid("Invalid recording identifier.") }
    return try root().appendingPathComponent(id, isDirectory: true)
  }

  private func store() throws -> DraftStore { try DraftStore(root: root(), timestamp: timestamp) }

  private func read(_ id: String) throws -> Draft { try store().read(id) }

  private func persist(_ draft: Draft) throws { try store().persist(draft) }

  private func timestamp() -> String { ISO8601DateFormatter().string(from: Date()) }
  private func epochMs() -> Double { Date().timeIntervalSince1970 * 1000 }

  private func representation(_ draft: Draft, levels: [Meter]) -> [String: Any] {
    ["id": draft.id, "matterId": draft.matterId as Any? ?? NSNull(),
     "status": draft.status.rawValue, "elapsedMs": draft.elapsedMs,
     "createdAt": draft.createdAt, "updatedAt": draft.updatedAt, "markers": draft.markers,
     "levels": levels.map { ["timeMs": $0.timeMs, "db": $0.db] },
     "lastMeterAt": (active?.id == draft.id ? lastMeterAt as Any? : nil) ?? NSNull(),
     "recordingSince": (active?.id == draft.id ? recordingSince as Any? : nil) ?? NSNull(),
     "cleaningProgress": cleaningProgress[draft.id] as Any? ?? NSNull()]
  }

  func listDrafts() throws -> [[String: Any]] {
    try io.sync {
      try store().list().map { saved in
        let draft: Draft
        if let current = active, current.id == saved.id { draft = current }
        else { draft = saved }
        return representation(draft, levels: draft.id == active?.id ? recentMeters : [])
      }
    }
  }

  func status(_ id: String) throws -> [String: Any] {
    try io.sync {
      if let captureError { throw CaptureFailure.invalid(captureError) }
      if let active, active.id == id { return representation(active, levels: recentMeters) }
      return try representation(read(id), levels: [])
    }
  }

  func start(_ matterId: String?) throws -> [String: Any] {
    guard io.sync(execute: { active?.status != .recording }) else { throw CaptureFailure.invalid("A recording is already active.") }
    let now = timestamp()
    let draft = Draft(id: UUID().uuidString, matterId: matterId, status: .paused,
      createdAt: now, updatedAt: now, markers: [], elapsedMs: 0)
    try io.sync {
      try FileManager.default.createDirectory(at: directory(draft.id), withIntermediateDirectories: true,
        attributes: [.protectionKey: FileProtectionType.completeUnlessOpen])
      let path = try directory(draft.id).appendingPathComponent("original.pcm")
      guard FileManager.default.createFile(atPath: path.path, contents: Data(),
        attributes: [.protectionKey: FileProtectionType.completeUnlessOpen])
      else { throw CaptureFailure.invalid("Recording storage could not be created.") }
      try persist(draft)
    }
    return try resume(draft.id)
  }

  func resume(_ id: String) throws -> [String: Any] {
    guard io.sync(execute: { active?.status != .recording }) else { throw CaptureFailure.invalid("A recording is already active.") }
    var draft = try io.sync { try read(id) }
    guard draft.status == .paused else { throw CaptureFailure.invalid("Only paused recordings can resume.") }
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .allowBluetooth])
    try session.setPreferredSampleRate(sampleRate)
    try session.setActive(true)
    let input = engine.inputNode
    let inputFormat = input.outputFormat(forBus: 0)
    guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0,
      let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false),
      let converter = AVAudioConverter(from: inputFormat, to: target)
    else { throw CaptureFailure.invalid("The microphone has no usable audio input.") }
    do {
      try io.sync {
        let resumed = try store().resume(id)
        audio = resumed.audio
        frames = resumed.frames
        draft = resumed.draft
        let levelsURL = try directory(id).appendingPathComponent("levels.jsonl")
        if !FileManager.default.fileExists(atPath: levelsURL.path) {
          guard FileManager.default.createFile(atPath: levelsURL.path, contents: Data(),
            attributes: [.protectionKey: FileProtectionType.completeUnlessOpen])
          else { throw CaptureFailure.invalid("Recording levels could not be stored.") }
        }
        meters = try FileHandle(forWritingTo: levelsURL)
        _ = try meters?.seekToEnd()
        draft.status = .recording
        draft.updatedAt = timestamp()
        active = draft
        captureError = nil
        lastMeterAt = nil
        recordingSince = epochMs()
        recentMeters = []
        bucketEnergy = 0
        bucketCount = 0
        try persist(draft)
      }
    } catch {
      io.sync {
        try? audio?.close()
        try? meters?.close()
        audio = nil
        meters = nil
        if var failed = active, failed.id == id {
          failed.status = .paused
          active = failed
        }
        recordingSince = nil
      }
      throw error
    }
    if hasTap { input.removeTap(onBus: 0); hasTap = false }
    input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(bucketFrames), format: inputFormat) { [weak self] buffer, _ in
      guard let self,
        let output = AVAudioPCMBuffer(pcmFormat: target,
          frameCapacity: AVAudioFrameCount(ceil(Double(buffer.frameLength) * self.sampleRate / inputFormat.sampleRate)) + 32)
      else { return }
      var supplied = false
      var conversionError: NSError?
      converter.convert(to: output, error: &conversionError) { _, state in
        if supplied { state.pointee = .noDataNow; return nil }
        supplied = true
        state.pointee = .haveData
        return buffer
      }
      if let conversionError {
        self.io.async { self.captureError = conversionError.localizedDescription }
        return
      }
      guard let samples = output.floatChannelData?[0], output.frameLength > 0 else { return }
      let count = Int(output.frameLength)
      let data = Data(bytes: samples, count: count * DictationPCM.bytesPerFrame)
      self.io.async { self.append(data, id: id) }
    }
    hasTap = true
    do { try engine.start() }
    catch {
      _ = try? pause(id)
      throw error
    }
    return try status(id)
  }

  private func append(_ data: Data, id: String) {
    guard var draft = active, draft.id == id, draft.status == .recording, captureError == nil else { return }
    do {
      try audio?.write(contentsOf: data)
      try data.withUnsafeBytes { raw in
        let samples = raw.bindMemory(to: Float.self)
        for sample in samples {
          bucketEnergy += Double(sample) * Double(sample)
          bucketCount += 1
          frames += 1
          if bucketCount == bucketFrames {
            let rms = sqrt(bucketEnergy / Double(bucketCount))
            let db = max(-160, min(0, 20 * log10(max(rms, 0.00000001))))
            let meter = Meter(timeMs: Double(frames) / sampleRate * 1000, db: db)
            recentMeters.append(meter)
            if recentMeters.count > 160 { recentMeters.removeFirst(recentMeters.count - 160) }
            var encoded = try JSONEncoder().encode(meter)
            encoded.append(10)
            try meters?.write(contentsOf: encoded)
            lastMeterAt = epochMs()
            bucketCount = 0
            bucketEnergy = 0
          }
        }
      }
      draft.elapsedMs = Double(frames) / sampleRate * 1000
      active = draft
      // One checkpoint per second; audio and meter journals never need rewriting.
      if frames / Int64(sampleRate) != (frames - Int64(data.count / DictationPCM.bytesPerFrame)) / Int64(sampleRate) {
        draft.updatedAt = timestamp()
        active = draft
        try audio?.synchronize()
        try meters?.synchronize()
        try persist(draft)
      }
    } catch { captureError = error.localizedDescription }
  }

  func pause(_ id: String) throws -> [String: Any] {
    guard io.sync(execute: { active?.id == id && active?.status == .recording }) else {
      throw CaptureFailure.invalid("Only an active recording can pause.")
    }
    engine.stop()
    if hasTap { engine.inputNode.removeTap(onBus: 0); hasTap = false }
    let result = try io.sync {
      guard var draft = active else { throw CaptureFailure.invalid("Recording state is missing.") }
      draft.status = .paused
      draft.updatedAt = timestamp()
      active = draft
      try audio?.synchronize()
      try audio?.close()
      try meters?.synchronize()
      try meters?.close()
      audio = nil
      meters = nil
      recordingSince = nil
      draft = try store().pause(id)
      active = draft
      return representation(draft, levels: recentMeters)
    }
    try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    return result
  }

  func finish(_ id: String) throws -> [String: Any] {
    if io.sync(execute: { active?.id == id && active?.status == .recording }) { _ = try pause(id) }
    return try io.sync {
      let draft = try store().finish(id)
      if active?.id == id { active = draft }
      return representation(draft, levels: active?.id == id ? recentMeters : [])
    }
  }

  func addMarker(_ id: String) throws -> [String: Any] {
    try io.sync {
      guard var draft = active, draft.id == id, draft.status == .recording else {
        throw CaptureFailure.invalid("Markers require an active recording.")
      }
      draft.markers.append(draft.elapsedMs)
      draft.updatedAt = timestamp()
      try persist(draft)
      active = draft
      return representation(draft, levels: recentMeters)
    }
  }

  func deleteDraft(_ id: String) throws {
    originalExportLock.lock()
    cleanedExportLock.lock()
    defer { cleanedExportLock.unlock(); originalExportLock.unlock() }
    try io.sync {
      guard active?.id != id || active?.status != .recording else {
        throw CaptureFailure.invalid("Pause the recording before deleting it.")
      }
      try store().delete(id)
      cleaningProgress.removeValue(forKey: id)
      if active?.id == id { active = nil; recentMeters = []; lastMeterAt = nil; recordingSince = nil }
    }
  }

  func shareableURL(_ uri: String) throws -> URL {
    try store().shareableURL(uri)
  }

  func exportAudio(_ id: String, cleaned: Bool) throws -> [String: Any] {
    let lock = cleaned ? cleanedExportLock : originalExportLock
    lock.lock()
    defer { lock.unlock() }
    let source = try io.sync { try store().finishedAudioSource(id) }
    var completed = false
    if cleaned { io.sync { cleaningProgress[id] = 0 } }
    defer { if cleaned { io.sync { cleaningProgress[id] = completed ? 1 : nil } } }
    let folder = try directory(id)
    let output = folder.appendingPathComponent(cleaned ? "cleaned.m4a" : "original.m4a")
    if !FileManager.default.fileExists(atPath: output.path) {
      let temporary = folder.appendingPathComponent(cleaned ? "cleaned-pending.m4a" : "original-pending.m4a")
      if FileManager.default.fileExists(atPath: temporary.path) {
        try FileManager.default.removeItem(at: temporary)
      }
      do {
        try encodeAudio(source: source, target: temporary, cleaned: cleaned) { progress in
          if cleaned { self.io.sync { self.cleaningProgress[id] = progress } }
        }
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUnlessOpen], ofItemAtPath: temporary.path)
        try FileManager.default.moveItem(at: temporary, to: output)
      } catch {
        try? FileManager.default.removeItem(at: temporary)
        throw error
      }
    }
    let handle = try FileHandle(forReadingFrom: output)
    defer { try? handle.close() }
    var hasher = SHA256()
    var size = 0
    while let block = try handle.read(upToCount: 65_536), !block.isEmpty {
      hasher.update(data: block)
      size += block.count
    }
    completed = true
    return ["uri": output.absoluteString, "size": size,
      "sha256Hex": hasher.finalize().map { String(format: "%02x", $0) }.joined()]
  }

  private func encodeAudio(source: URL, target: URL, cleaned: Bool, progress: @escaping (Double) -> Void) throws {
    guard let inputFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false),
      let outputFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24_000, channels: 1, interleaved: false),
      let converter = AVAudioConverter(from: inputFormat, to: outputFormat)
    else { throw CaptureFailure.invalid("Audio export could not be configured.") }
    let file = try AVAudioFile(forWriting: target, settings: [
      AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 24_000,
      AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64_000,
    ], commonFormat: .pcmFormatFloat32, interleaved: false)
    let sourceFile = try FileHandle(forReadingFrom: source)
    defer { try? sourceFile.close() }
    let denoiser = cleaned ? rnnoise_create() : nil
    if cleaned && denoiser == nil { throw CaptureFailure.invalid("Noise suppression could not be initialized.") }
    defer { if let denoiser { rnnoise_destroy(denoiser) } }
    let sourceBytes = try FileManager.default.attributesOfItem(atPath: source.path)[.size] as? NSNumber
    let totalFrames = max(1, (sourceBytes?.int64Value ?? 0) / Int64(DictationPCM.bytesPerFrame))
    var processedFrames: Int64 = 0
    var reportedFrames: Int64 = 0
    var sourceEnded = false
    var finished = false
    var processingError: Error?
    while !finished {
      guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: 2_400) else {
        throw CaptureFailure.invalid("Audio export buffer could not be allocated.")
      }
      var conversionError: NSError?
      let result = converter.convert(to: output, error: &conversionError) { packets, state in
        if sourceEnded { state.pointee = .endOfStream; return nil }
        do {
          let requested = min(Int(packets), 4_800)
          let byteCount = cleaned ? max(480, requested / 480 * 480) * 4 : max(1, requested) * 4
          guard let data = try sourceFile.read(upToCount: byteCount), data.count >= 4 else {
            sourceEnded = true
            state.pointee = .endOfStream
            return nil
          }
          let count = data.count / 4
          let capacity = cleaned ? (count + 479) / 480 * 480 : count
          guard let input = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: AVAudioFrameCount(capacity)),
            let values = input.floatChannelData?[0]
          else { throw CaptureFailure.invalid("Audio input buffer could not be allocated.") }
          values.initialize(repeating: 0, count: capacity)
          data.withUnsafeBytes { raw in memcpy(values, raw.baseAddress!, count * 4) }
          if let denoiser {
            for offset in stride(from: 0, to: capacity, by: 480) {
              for index in offset..<(offset + 480) { values[index] *= 32_768 }
              rnnoise_process_frame(denoiser, values + offset, values + offset)
              for index in offset..<(offset + 480) { values[index] /= 32_768 }
            }
          }
          processedFrames += Int64(count)
          if processedFrames - reportedFrames >= 24_000 {
            progress(min(1, Double(processedFrames) / Double(totalFrames)))
            reportedFrames = processedFrames
          }
          input.frameLength = AVAudioFrameCount(count)
          state.pointee = .haveData
          return input
        } catch {
          processingError = error
          sourceEnded = true
          state.pointee = .endOfStream
          return nil
        }
      }
      if let processingError { throw processingError }
      if let conversionError { throw conversionError }
      if output.frameLength > 0 { try file.write(from: output) }
      if result == .endOfStream { finished = true }
    }
  }
}
