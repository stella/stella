import CryptoKit
import ExpoModulesCore
import VisionKit

/// Scans paper with the system document camera, which finds each page's
/// edges, straightens it and corrects its perspective as it captures. The
/// pages stay separate images until the person is done with them, so they
/// can be turned, reordered, removed or added to; `buildPdf` then binds them
/// into one PDF to share or upload.
public class DocumentScannerModule: Module {
  private var session: ScanSession?

  public func definition() -> ModuleDefinition {
    Name("DocumentScanner")

    // The simulator and some devices have no document camera.
    Function("isSupported") {
      VNDocumentCameraViewController.isSupported
    }

    // A review's pages go into its own folder (`review` names it), so one
    // review's discard leaves another's files alone.
    AsyncFunction("scan") { (review: String, promise: Promise) in
      guard let folder = ScanFiles.folder(of: review) else {
        promise.reject("ERR_SCANNER_FAILED", "The scan has no review to go to.")
        return
      }
      guard VNDocumentCameraViewController.isSupported else {
        promise.reject("ERR_SCANNER_UNSUPPORTED", "This device has no document camera.")
        return
      }
      guard self.session == nil else {
        promise.reject("ERR_SCANNER_BUSY", "A scan is already open.")
        return
      }
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        promise.reject("ERR_SCANNER_NO_SCREEN", "There is no screen to scan from.")
        return
      }
      let camera = VNDocumentCameraViewController()
      let session = ScanSession { [weak self] outcome in
        camera.dismiss(animated: true)
        self?.session = nil
        switch outcome {
        case .cancelled:
          promise.resolve(nil)
        case .scanned(let images):
          // Encoding full pages takes a moment each; the camera is already
          // closing, so it happens off the main thread.
          DispatchQueue.global(qos: .userInitiated).async {
            switch ScanFiles.write(images, into: folder) {
            case .success(let pages):
              promise.resolve(pages.map { $0.record })
            case .failure(let failure):
              promise.reject("ERR_SCANNER_FAILED", failure.reason)
            }
          }
        case .failed(let message):
          promise.reject("ERR_SCANNER_FAILED", message)
        }
      }
      camera.delegate = session
      self.session = session
      presenter.present(camera, animated: true)
    }.runOnQueue(.main)

    // Binds pages, in the order given and each turned clockwise by its
    // rotation, into one PDF named `name` (already ending in `.pdf`), which
    // is the name the share sheet and the files it saves to show.
    AsyncFunction("buildPdf") {
      (review: String, name: String, pages: [PdfPageRecord]) throws -> [String: Any] in
      guard let folder = ScanFiles.folder(of: review) else {
        throw ScanFilesException("The scan has no review.")
      }
      switch ScanFiles.buildPdf(name: name, pages: pages, in: folder) {
      case .success(let file):
        return [
          "uri": file.url.absoluteString,
          "pageCount": file.pageCount,
          "size": file.size,
          "sha256Hex": file.sha256Hex,
        ]
      case .failure(let failure):
        throw failure
      }
    }

    // Removes every page and PDF a review's scans wrote, once the person is done.
    Function("discard") { (review: String) in
      if let folder = ScanFiles.folder(of: review) {
        ScanFiles.discard(folder)
      }
    }
  }
}

/// A page to put into a PDF: its image file and its clockwise turn.
struct PdfPageRecord: Record {
  @Field var uri: String = ""
  /// Degrees clockwise: 0, 90, 180 or 270.
  @Field var rotation: Int = 0
}

/// Why a scan's files could not be written or bound.
final class ScanFilesException: GenericException<String> {
  override var reason: String { param }
}

/// A scanned page on disk: the full image, a small one for the list, and
/// the full image's size in bytes.
private struct ScannedPage {
  let url: URL
  let thumbnailURL: URL
  let size: Int

  var record: [String: Any] {
    [
      "uri": url.absoluteString,
      "thumbnailUri": thumbnailURL.absoluteString,
      "size": size,
    ]
  }
}

/// The PDF the pages were bound into, with the size and digest an upload is
/// signed for.
private struct BuiltPdf {
  let url: URL
  let pageCount: Int
  let size: Int
  let sha256Hex: String
}

/// Where a scan's files live: a folder for each review in the app's
/// temporary files, so `discard` can remove all of a review's files and
/// nothing else.
private enum ScanFiles {
  /// JPEG quality of a full page: legible print at a few hundred kilobytes.
  static let pageQuality: CGFloat = 0.6
  /// The longer side of a list thumbnail, in pixels.
  static let thumbnailSide: CGFloat = 240

  /// The folder of the review `review` names, which must be a UUID, so it
  /// can never name a path outside the scans.
  static func folder(of review: String) -> URL? {
    guard let id = UUID(uuidString: review) else {
      return nil
    }
    return FileManager.default.temporaryDirectory
      .appendingPathComponent("document-scans", isDirectory: true)
      .appendingPathComponent(id.uuidString, isDirectory: true)
  }

  /// Writes the pages into `folder`. A scan that fails removes what it
  /// wrote, since no review shows those pages.
  static func write(_ images: [UIImage], into folder: URL)
    -> Result<[ScannedPage], ScanFilesException>
  {
    guard (try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true))
      != nil
    else {
      return .failure(ScanFilesException("The scan could not be saved."))
    }
    var pages: [ScannedPage] = []
    for image in images {
      let written: ScannedPage? = autoreleasepool {
        let page = ScanFiles.upright(image)
        let id = UUID().uuidString
        let url = folder.appendingPathComponent("page-\(id).jpg")
        let thumbnailURL = folder.appendingPathComponent("page-\(id)-thumbnail.jpg")
        guard let data = page.jpegData(compressionQuality: pageQuality),
          let small = ScanFiles.thumbnail(of: page).jpegData(compressionQuality: 0.7),
          (try? data.write(to: url)) != nil,
          (try? small.write(to: thumbnailURL)) != nil
        else {
          try? FileManager.default.removeItem(at: url)
          try? FileManager.default.removeItem(at: thumbnailURL)
          return nil
        }
        return ScannedPage(url: url, thumbnailURL: thumbnailURL, size: data.count)
      }
      guard let scanned = written else {
        for page in pages {
          try? FileManager.default.removeItem(at: page.url)
          try? FileManager.default.removeItem(at: page.thumbnailURL)
        }
        return .failure(ScanFilesException("The scan could not be saved."))
      }
      pages.append(scanned)
    }
    return pages.isEmpty
      ? .failure(ScanFilesException("The scan has no pages."))
      : .success(pages)
  }

  /// Each page on an A4 sheet turned to its orientation, the image fitted
  /// inside. The JPEG goes into the PDF as it is, not encoded again, so the
  /// PDF is about the size of its pages together.
  static func buildPdf(name: String, pages: [PdfPageRecord], in folder: URL)
    -> Result<BuiltPdf, ScanFilesException>
  {
    guard !pages.isEmpty else {
      return .failure(ScanFilesException("There are no pages to save."))
    }
    let data = NSMutableData()
    guard let consumer = CGDataConsumer(data: data as CFMutableData),
      let context = CGContext(consumer: consumer, mediaBox: nil, nil)
    else {
      return .failure(ScanFilesException("The PDF could not be made."))
    }
    for page in pages {
      guard let url = URL(string: page.uri), url.isFileURL,
        isInside(folder, url),
        let provider = CGDataProvider(url: url as CFURL),
        let image = CGImage(
          jpegDataProviderSource: provider, decode: nil, shouldInterpolate: true,
          intent: .defaultIntent)
      else {
        context.closePDF()
        return .failure(ScanFilesException("A page of the scan could not be read."))
      }
      draw(image, turnedBy: page.rotation, into: context)
    }
    context.closePDF()

    let pdf = data as Data
    let pdfFolder = folder.appendingPathComponent("pdf-\(UUID().uuidString)", isDirectory: true)
    let url = pdfFolder.appendingPathComponent(fileName(name))
    guard (try? FileManager.default.createDirectory(at: pdfFolder, withIntermediateDirectories: true))
      != nil,
      (try? pdf.write(to: url)) != nil
    else {
      return .failure(ScanFilesException("The PDF could not be saved."))
    }
    let digest = SHA256.hash(data: pdf).map { String(format: "%02x", $0) }.joined()
    return .success(
      BuiltPdf(url: url, pageCount: pages.count, size: pdf.count, sha256Hex: digest))
  }

  /// Whether `url` is one of the scan's own files, so a page can never name
  /// another file of the app's.
  private static func isInside(_ folder: URL, _ url: URL) -> Bool {
    url.resolvingSymlinksInPath().path.hasPrefix(folder.resolvingSymlinksInPath().path + "/")
  }

  static func discard(_ folder: URL) {
    try? FileManager.default.removeItem(at: folder)
  }

  /// One PDF page: A4, landscape when the turned image is wider than tall.
  private static func draw(_ image: CGImage, turnedBy rotation: Int, into context: CGContext) {
    let quarterTurns = ((rotation / 90) % 4 + 4) % 4
    let width = CGFloat(image.width)
    let height = CGFloat(image.height)
    let turnedSize =
      quarterTurns % 2 == 0 ? CGSize(width: width, height: height) : CGSize(width: height, height: width)
    let a4 = CGSize(width: 595, height: 842)
    let sheet =
      turnedSize.width > turnedSize.height ? CGSize(width: a4.height, height: a4.width) : a4
    var mediaBox = CGRect(origin: .zero, size: sheet)
    let scale = min(sheet.width / turnedSize.width, sheet.height / turnedSize.height)

    let boxData = NSData(bytes: &mediaBox, length: MemoryLayout<CGRect>.size)
    context.beginPDFPage([kCGPDFContextMediaBox as String: boxData] as CFDictionary)
    context.saveGState()
    context.translateBy(x: sheet.width / 2, y: sheet.height / 2)
    // PDF space has y up, so a clockwise turn is a negative angle.
    context.rotate(by: -CGFloat(quarterTurns) * .pi / 2)
    let drawn = CGSize(width: width * scale, height: height * scale)
    context.draw(
      image,
      in: CGRect(
        x: -drawn.width / 2, y: -drawn.height / 2, width: drawn.width, height: drawn.height))
    context.restoreGState()
    context.endPDFPage()
  }

  /// The camera's pages are upright already; one that is not is redrawn,
  /// since a JPEG's orientation tag would not reach the PDF.
  private static func upright(_ image: UIImage) -> UIImage {
    guard image.imageOrientation != .up else {
      return image
    }
    let format = UIGraphicsImageRendererFormat()
    format.scale = image.scale
    return UIGraphicsImageRenderer(size: image.size, format: format).image { _ in
      image.draw(in: CGRect(origin: .zero, size: image.size))
    }
  }

  private static func thumbnail(of image: UIImage) -> UIImage {
    let longer = max(image.size.width, image.size.height) * image.scale
    let ratio = min(1, thumbnailSide / max(longer, 1))
    let size = CGSize(
      width: (image.size.width * image.scale * ratio).rounded(),
      height: (image.size.height * image.scale * ratio).rounded())
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    return UIGraphicsImageRenderer(size: size, format: format).image { _ in
      image.draw(in: CGRect(origin: .zero, size: size))
    }
  }

  /// A file name the system accepts: no folder separators or control
  /// characters, not empty, and not longer than a file name may be, counted
  /// in UTF-8 bytes, since one character can take many.
  private static func fileName(_ name: String) -> String {
    let unsafe = CharacterSet(charactersIn: "/:\\").union(.controlCharacters)
    let cleaned = name.components(separatedBy: unsafe).joined(separator: "-")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let stem = cleaned.lowercased().hasSuffix(".pdf") ? String(cleaned.dropLast(4)) : cleaned
    var truncated = ""
    for character in stem {
      guard truncated.utf8.count + String(character).utf8.count <= 200 else {
        break
      }
      truncated.append(character)
    }
    let trimmed = truncated.trimmingCharacters(in: .whitespacesAndNewlines)
    return "\(trimmed.isEmpty || trimmed.hasPrefix(".") ? "Scan" : trimmed).pdf"
  }
}

private enum ScanOutcome {
  case cancelled
  case scanned([UIImage])
  case failed(String)
}

/// One open document camera: it reports once, however the camera closes.
private final class ScanSession: NSObject, VNDocumentCameraViewControllerDelegate {
  private let finish: (ScanOutcome) -> Void

  init(finish: @escaping (ScanOutcome) -> Void) {
    self.finish = finish
  }

  func documentCameraViewController(
    _ controller: VNDocumentCameraViewController,
    didFinishWith scan: VNDocumentCameraScan
  ) {
    finish(.scanned((0..<scan.pageCount).map { scan.imageOfPage(at: $0) }))
  }

  func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
    finish(.cancelled)
  }

  func documentCameraViewController(
    _ controller: VNDocumentCameraViewController,
    didFailWithError error: Error
  ) {
    finish(.failed(error.localizedDescription))
  }
}
