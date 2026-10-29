import Foundation

@main struct DraftStoreTests {
  static func main() throws {
    var requestsA = CaptureRequests()
    let requestsB = CaptureRequests()
    let pendingA = requestsA.ticket
    let pendingB = requestsB.ticket
    precondition(requestsA.ticket == pendingA, "A pending permission request is current")
    requestsA.invalidate()
    precondition(requestsA.ticket != pendingA, "Suspension invalidates an outstanding permission prompt")
    precondition(requestsB.ticket == pendingB, "Suspension leaves another account request intact")
    let nextRequest = requestsA.ticket
    precondition(nextRequest != pendingA && nextRequest == requestsA.ticket, "A new explicit request can start after suspension")
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let accountA = try DraftScope.rootKey(serverOrigin: "https://example.test", userId: "uživatel-Šťastný")
    let accountB = try DraftScope.rootKey(serverOrigin: "https://example.test", userId: "uživatel-Ľubica")
    let otherServer = try DraftScope.rootKey(serverOrigin: "https://other.example.test", userId: "uživatel-Šťastný")
    precondition(accountA != accountB && accountA != otherServer, "Account and server scopes are separate")
    let normalized = try DraftScope.rootKey(serverOrigin: "HTTPS://EXAMPLE.TEST:443/", userId: "uživatel-Šťastný")
    precondition(normalized == accountA, "Equivalent origins share the account root")
    let accountRoot = root.appendingPathComponent(accountA)
    try FileManager.default.createDirectory(at: accountRoot, withIntermediateDirectories: true)
    let store = DraftStore(root: accountRoot, timestamp: { "2026-10-29T09:00:00Z" })
    let first = try create(store, matterId: "Žaloba Šťastného", frames: 48_000)
    let second = try create(store, matterId: "Návrh Ľubice", frames: 96_000)
    let hiddenStore = DraftStore(root: root.appendingPathComponent(accountB), timestamp: { "2026-10-29T09:00:00Z" })
    do { _ = try hiddenStore.read(first); preconditionFailure("Another account read a recording") }
    catch { precondition(error is CocoaError, "Different account has no matching file") }
    let serverStore = DraftStore(root: root.appendingPathComponent(otherServer), timestamp: { "2026-10-29T09:00:00Z" })
    do { _ = try serverStore.read(first); preconditionFailure("Another server read a recording") }
    catch { precondition(error is CocoaError, "Different server has no matching file") }
    try FileManager.default.createDirectory(at: hiddenStore.root, withIntermediateDirectories: true)
    let foreign = try create(hiddenStore, matterId: "Návrh Ľubice", frames: 48_000)
    _ = try hiddenStore.finish(foreign)
    expectMissing { _ = try store.read(foreign) }
    expectMissing { _ = try store.resume(foreign) }
    expectMissing { try store.delete(foreign) }
    expectMissing { _ = try store.finishedAudioSource(foreign) }
    let orphan = try store.directory(UUID().uuidString)
    try FileManager.default.createDirectory(at: orphan, withIntermediateDirectories: true)
    let visible = try store.list()
    precondition(Set(visible.map(\.id)) == Set([first, second]), "Incomplete empty directory cannot hide healthy drafts")
    let foreignVisible = try hiddenStore.list()
    precondition(foreignVisible.map(\.id) == [foreign], "Another account lists only its own recording")
    let foreignExport = try hiddenStore.directory(foreign).appendingPathComponent("original.m4a")
    try Data([1, 2, 3]).write(to: foreignExport)
    do { _ = try store.shareableURL(foreignExport.absoluteString); preconditionFailure("Shared another account recording") }
    catch CaptureFailure.invalid(let message) { precondition(message == "The audio export is unavailable.") }
    let sameAccountExport = try hiddenStore.shareableURL(foreignExport.absoluteString)
    precondition(sameAccountExport == foreignExport, "The owning account can share its export")
    for trailingBytes in 0..<4 {
      let interrupted = try create(store, matterId: "Návrh Šťastného", frames: 480)
      let url = try store.directory(interrupted).appendingPathComponent("original.pcm")
      let append = try FileHandle(forWritingTo: url)
      try append.seekToEnd()
      try append.write(contentsOf: Data(repeating: 17, count: trailingBytes))
      try append.close()
      let repairedOnce = try store.resume(interrupted)
      try repairedOnce.audio.close()
      let once = try Data(contentsOf: url)
      let repairedTwice = try store.resume(interrupted)
      try repairedTwice.audio.close()
      let twice = try Data(contentsOf: url)
      precondition(repairedOnce.frames == 480 && repairedTwice.frames == 480 && once == twice && once.count == 1920,
        "Crash repair is a fixed point over every partial float alignment")
      try store.delete(interrupted)
    }
    let firstAudio = try store.directory(first).appendingPathComponent("original.pcm")
    let handle = try FileHandle(forWritingTo: firstAudio)
    try handle.seekToEnd()
    try handle.write(contentsOf: Data([1, 2, 3]))
    try handle.close()
    let recovered = try store.read(first)
    precondition(recovered.status == .paused && recovered.elapsedMs == 1000, "Crash recovery aligns partial PCM")
    precondition(recovered.matterId == "Žaloba Šťastného", "Crash recovery preserves matter")
    let resumed = try store.resume(first)
    precondition(resumed.frames == 48_000 && resumed.draft.status == .recording, "Resume appends at complete frame")
    try resumed.audio.write(contentsOf: Data(repeating: 0, count: 48_000 * 4))
    try resumed.audio.close()
    let appended = try store.read(first)
    precondition(appended.elapsedMs == 2000, "Resumed PCM is durable before metadata checkpoint")
    let paused = try store.pause(first)
    precondition(paused.status == .paused && paused.elapsedMs == 2000 && paused.markers == [500], "Interruption checkpoint retains duration and markers")
    let afterInterruption = try store.resume(first)
    precondition(afterInterruption.frames == 96_000, "Resume after interruption appends at saved duration")
    try afterInterruption.audio.close()
    do { _ = try store.finishedAudioSource(first); preconditionFailure("Unfinished audio exported") }
    catch CaptureFailure.invalid(let message) { precondition(message == "Finish the recording before exporting.") }
    let finished = try store.finish(first)
    precondition(finished.status == .finished && finished.elapsedMs == 2000, "Finish preserves audio")
    let exportSource = try store.finishedAudioSource(first)
    precondition(exportSource == firstAudio, "Finished exports read the original journal")
    do { _ = try store.resume(first); preconditionFailure("Finished draft resumed") }
    catch CaptureFailure.invalid(let message) { precondition(message == "Only paused recordings can resume.") }
    do { _ = try store.finish(first); preconditionFailure("Finished draft finished twice") }
    catch CaptureFailure.invalid(let message) { precondition(message == "The recording is already finished.") }
    let secondDirectory = try store.directory(second)
    try Data("{broken".utf8).write(to: secondDirectory.appendingPathComponent("metadata.json"))
    let corrupt = try store.read(second)
    precondition(corrupt.elapsedMs == 2000 && corrupt.status == .paused, "Corrupt metadata retains audio")
    let recoveredList = try store.list()
    precondition(Set(recoveredList.map(\.id)) == Set([first, second]), "Corrupt metadata cannot hide another draft")
    let original = try Data(contentsOf: firstAudio)
    let repaired = try store.resume(second)
    try repaired.audio.close()
    _ = try store.finish(second)
    let unchanged = try Data(contentsOf: firstAudio)
    precondition(unchanged == original, "Two drafts are independent")
    try store.delete(second)
    precondition(!FileManager.default.fileExists(atPath: secondDirectory.path), "Explicit delete removes draft")
    precondition(FileManager.default.fileExists(atPath: firstAudio.path), "Delete preserves other draft")
    do { _ = try store.directory("../original"); preconditionFailure("Invalid identifier accepted") }
    catch CaptureFailure.invalid(let message) { precondition(message == "Invalid recording identifier.") }
    for invalid in ["https://example.test/path", "file:///tmp", "https://name:secret@example.test", "https://example.test?query=1"] {
      do { _ = try DraftScope.rootKey(serverOrigin: invalid, userId: "user"); preconditionFailure("Invalid scope accepted") }
      catch CaptureFailure.invalid(let message) { precondition(message == "Recording account context is invalid.") }
    }
    print("PASS scoped accounts and servers; draft crash recovery, partial frame repair, resume, finish, corrupt metadata, two drafts, delete")
  }

  static func expectMissing(_ operation: () throws -> Void) {
    do { try operation(); preconditionFailure("A foreign recording was accessible") }
    catch { precondition(error is CocoaError, "The foreign recording has no file inside this scope") }
  }

  static func create(_ store: DraftStore, matterId: String, frames: Int) throws -> String {
    let id = UUID().uuidString
    let directory = try store.directory(id)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try Data(repeating: 0, count: frames * 4).write(to: directory.appendingPathComponent("original.pcm"))
    let draft = Draft(id: id, matterId: matterId, status: .recording,
      createdAt: "2026-10-29T08:00:00Z", updatedAt: "2026-10-29T08:00:00Z", markers: [500], elapsedMs: 0)
    try store.persist(draft)
    return id
  }
}
