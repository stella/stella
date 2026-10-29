import ExpoModulesCore
import QuickLook

/// The files of opened documents. A document is downloaded natively rather
/// than by the viewer's web view: the storage link allows only the web app's
/// origins, and a native download keeps the bytes out of JavaScript strings
/// until the viewer asks for them. Each file lives in its own folder under
/// caches, protected while the phone is locked, and is removed when its
/// viewer closes; whatever a crash left behind is removed at launch.
public class DocumentFilesModule: Module {
  private var preview: PreviewSession?

  private static let root = FileManager.default
    .urls(for: .cachesDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("opened-documents", isDirectory: true)

  private static let session: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 30
    configuration.timeoutIntervalForResource = 300
    return URLSession(configuration: configuration)
  }()

  public func definition() -> ModuleDefinition {
    Name("DocumentFiles")

    OnCreate {
      try? FileManager.default.removeItem(at: Self.root)
    }

    AsyncFunction("download") { (url: URL, fileName: String, promise: Promise) in
      let folder = Self.root.appendingPathComponent(UUID().uuidString, isDirectory: true)
      let destination = folder.appendingPathComponent(Self.safeName(fileName))
      Self.session.downloadTask(with: url) { location, response, error in
        if let error = error as? URLError {
          promise.reject(
            Self.isOffline(error) ? "ERR_DOCUMENT_OFFLINE" : "ERR_DOCUMENT_DOWNLOAD",
            error.localizedDescription)
          return
        }
        guard let location, error == nil,
          let status = (response as? HTTPURLResponse)?.statusCode, (200..<300).contains(status)
        else {
          promise.reject("ERR_DOCUMENT_DOWNLOAD", "The document could not be downloaded.")
          return
        }
        do {
          try FileManager.default.createDirectory(
            at: folder, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.complete])
          try FileManager.default.moveItem(at: location, to: destination)
          try FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.complete], ofItemAtPath: destination.path)
          let size = try FileManager.default.attributesOfItem(atPath: destination.path)[.size]
          promise.resolve(["uri": destination.absoluteString, "size": size as? Int ?? 0])
        } catch {
          try? FileManager.default.removeItem(at: folder)
          promise.reject("ERR_DOCUMENT_DOWNLOAD", error.localizedDescription)
        }
      }.resume()
    }

    // The viewer asks for the file a slice at a time, so no single message to
    // the web view carries the whole document.
    AsyncFunction("readBase64") { (uri: URL, offset: Int, length: Int) throws -> String in
      guard Self.isOpened(uri), offset >= 0, length > 0 else {
        throw Exception(name: "ERR_DOCUMENT_READ", description: "Not an opened document.")
      }
      let handle = try FileHandle(forReadingFrom: uri)
      defer { try? handle.close() }
      try handle.seek(toOffset: UInt64(offset))
      return (try handle.read(upToCount: length) ?? Data()).base64EncodedString()
    }

    AsyncFunction("preview") { (uri: URL, promise: Promise) in
      guard Self.isOpened(uri) else {
        promise.reject("ERR_DOCUMENT_READ", "Not an opened document.")
        return
      }
      guard self.preview == nil else {
        promise.reject("ERR_DOCUMENT_BUSY", "A preview is already open.")
        return
      }
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        promise.reject("ERR_DOCUMENT_NO_SCREEN", "There is no screen to preview on.")
        return
      }
      let controller = QLPreviewController()
      let session = PreviewSession(item: uri as NSURL) { [weak self] in
        self?.preview = nil
        promise.resolve(nil)
      }
      controller.dataSource = session
      controller.delegate = session
      self.preview = session
      presenter.present(controller, animated: true)
    }.runOnQueue(.main)

    Function("discard") { (uri: URL) in
      guard Self.isOpened(uri) else {
        return
      }
      try? FileManager.default.removeItem(at: uri.deletingLastPathComponent())
    }
  }

  /// A file inside one of this module's folders, never anything else on disk.
  private static func isOpened(_ uri: URL) -> Bool {
    uri.isFileURL
      && uri.standardizedFileURL.deletingLastPathComponent().deletingLastPathComponent()
        .path == root.standardizedFileURL.path
  }

  /// The stored name, which Quick Look shows and reads the type from, as one
  /// path component.
  private static func safeName(_ fileName: String) -> String {
    let name = fileName.replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: ":", with: "_")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return name.isEmpty || name.hasPrefix(".") ? "document\(name)" : name
  }

  private static func isOffline(_ error: URLError) -> Bool {
    [
      .notConnectedToInternet, .networkConnectionLost, .timedOut, .cannotFindHost,
      .cannotConnectToHost, .dnsLookupFailed, .dataNotAllowed, .internationalRoamingOff,
    ].contains(error.code)
  }
}

/// One open Quick Look preview of one file: it reports once, when it closes.
private final class PreviewSession: NSObject, QLPreviewControllerDataSource,
  QLPreviewControllerDelegate
{
  private let item: NSURL
  private let closed: () -> Void

  init(item: NSURL, closed: @escaping () -> Void) {
    self.item = item
    self.closed = closed
  }

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
    1
  }

  func previewController(_ controller: QLPreviewController, previewItemAt index: Int)
    -> QLPreviewItem
  {
    item
  }

  func previewControllerDidDismiss(_ controller: QLPreviewController) {
    closed()
  }
}
