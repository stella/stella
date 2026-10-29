import Foundation

// Raw PCM is fixed at mono float32, 48 kHz. File length is authoritative after
// interruption; a partial last float is excluded and truncated before resuming.
enum DictationPCM {
  static let sampleRate = 48_000.0
  static let bytesPerFrame = MemoryLayout<Float>.size
  static let bucketFrames = 2_400
}

enum DraftStatus: String, Codable { case recording, paused, finished }
struct Draft: Codable {
  let id: String
  let matterId: String?
  var status: DraftStatus
  let createdAt: String
  var updatedAt: String
  var markers: [Double]
  var elapsedMs: Double
}
enum CaptureFailure: LocalizedError {
  case invalid(String)
  var errorDescription: String? {
    switch self { case .invalid(let message): return message }
  }
}

struct DraftStore {
  let root: URL
  let timestamp: () -> String

  func directory(_ id: String) throws -> URL {
    guard UUID(uuidString: id)?.uuidString == id else {
      throw CaptureFailure.invalid("Invalid recording identifier.")
    }
    return root.appendingPathComponent(id, isDirectory: true)
  }

  func list() throws -> [Draft] {
    try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
      .filter { UUID(uuidString: $0.lastPathComponent) != nil && FileManager.default.fileExists(atPath: $0.appendingPathComponent("original.pcm").path) }
      .map { try read($0.lastPathComponent) }
  }

  func shareableURL(_ uri: String) throws -> URL {
    guard let url = URL(string: uri), url.isFileURL,
      url.standardizedFileURL.path.hasPrefix(root.standardizedFileURL.path + "/"),
      url.pathExtension == "m4a", FileManager.default.fileExists(atPath: url.path)
    else { throw CaptureFailure.invalid("The audio export is unavailable.") }
    return url
  }

  func finishedAudioSource(_ id: String) throws -> URL {
    guard try read(id).status == .finished else {
      throw CaptureFailure.invalid("Finish the recording before exporting.")
    }
    return try directory(id).appendingPathComponent("original.pcm")
  }

  func read(_ id: String) throws -> Draft {
    let directory = try directory(id)
    let pcm = directory.appendingPathComponent("original.pcm")
    let size = try FileManager.default.attributesOfItem(atPath: pcm.path)[.size] as? NSNumber
    let elapsedMs = Double((size?.int64Value ?? 0) / Int64(DictationPCM.bytesPerFrame)) / DictationPCM.sampleRate * 1000
    let metadata = directory.appendingPathComponent("metadata.json")
    do {
      var draft = try JSONDecoder().decode(Draft.self, from: Data(contentsOf: metadata))
      guard draft.id == id, draft.elapsedMs.isFinite,
        draft.markers.allSatisfy({ $0.isFinite && $0 >= 0 })
      else { throw CaptureFailure.invalid("Recording metadata is invalid.") }
      draft.elapsedMs = elapsedMs
      draft.markers = draft.markers.filter { $0 <= elapsedMs }
      if draft.status == .recording { draft.status = .paused }
      return draft
    } catch {
      // A damaged checkpoint cannot make an intact audio journal disappear.
      let now = timestamp()
      return Draft(id: id, matterId: nil, status: .paused, createdAt: now,
        updatedAt: now, markers: [], elapsedMs: elapsedMs)
    }
  }

  func persist(_ draft: Draft) throws {
    let url = try directory(draft.id).appendingPathComponent("metadata.json")
    #if os(iOS)
      try JSONEncoder().encode(draft).write(to: url, options: [.atomic, .completeFileProtectionUnlessOpen])
    #else
      try JSONEncoder().encode(draft).write(to: url, options: [.atomic])
    #endif
  }

  func resume(_ id: String) throws -> (draft: Draft, audio: FileHandle, frames: Int64) {
    var draft = try read(id)
    guard draft.status == .paused else {
      throw CaptureFailure.invalid("Only paused recordings can resume.")
    }
    let audio = try FileHandle(forWritingTo: directory(id).appendingPathComponent("original.pcm"))
    do {
      let bytes = try audio.seekToEnd()
      let width = UInt64(DictationPCM.bytesPerFrame)
      let aligned = bytes / width * width
      try audio.truncate(atOffset: aligned)
      try audio.seek(toOffset: aligned)
      draft.status = .recording
      draft.updatedAt = timestamp()
      try persist(draft)
      return (draft, audio, Int64(aligned / width))
    } catch {
      try? audio.close()
      throw error
    }
  }

  func pause(_ id: String) throws -> Draft {
    var draft = try read(id)
    guard draft.status == .paused else {
      throw CaptureFailure.invalid("Only unfinished recordings can pause.")
    }
    draft.updatedAt = timestamp()
    try persist(draft)
    return draft
  }

  func finish(_ id: String) throws -> Draft {
    var draft = try read(id)
    guard draft.status == .paused else {
      throw CaptureFailure.invalid("The recording is already finished.")
    }
    draft.status = .finished
    draft.updatedAt = timestamp()
    try persist(draft)
    return draft
  }

  func delete(_ id: String) throws {
    try FileManager.default.removeItem(at: directory(id))
  }
}
