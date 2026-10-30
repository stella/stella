import CryptoKit
import ExpoModulesCore
import PDFKit
import VisionKit

/// Scans paper with the system document camera, which finds each page's
/// edges, straightens it and corrects its perspective as it captures, and
/// writes the pages into one PDF the app can upload.
public class DocumentScannerModule: Module {
  private var session: ScanSession?

  public func definition() -> ModuleDefinition {
    Name("DocumentScanner")

    // The simulator and some devices have no document camera.
    Function("isSupported") {
      VNDocumentCameraViewController.isSupported
    }

    AsyncFunction("scan") { (promise: Promise) in
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
        case .scanned(let file):
          promise.resolve([
            "uri": file.url.absoluteString,
            "pageCount": file.pageCount,
            "size": file.size,
            "sha256Hex": file.sha256Hex,
          ])
        case .failed(let message):
          promise.reject("ERR_SCANNER_FAILED", message)
        }
      }
      camera.delegate = session
      self.session = session
      presenter.present(camera, animated: true)
    }.runOnQueue(.main)
  }
}

/// The PDF a scan wrote, with the size and digest an upload is signed for.
private struct ScannedFile {
  let url: URL
  let pageCount: Int
  let size: Int
  let sha256Hex: String
}

private enum ScanOutcome {
  case cancelled
  case scanned(ScannedFile)
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
    let pdf = PDFDocument()
    for index in 0..<scan.pageCount {
      if let page = page(of: scan.imageOfPage(at: index)) {
        pdf.insert(page, at: pdf.pageCount)
      }
    }
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("scan-\(UUID().uuidString).pdf")
    guard pdf.pageCount > 0, let data = pdf.dataRepresentation(),
      (try? data.write(to: url)) != nil
    else {
      finish(.failed("The scan could not be saved."))
      return
    }
    let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    finish(
      .scanned(
        ScannedFile(url: url, pageCount: pdf.pageCount, size: data.count, sha256Hex: digest)
      ))
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

  /// A page the size of A4, turned to the scan's orientation, with the scan
  /// fitted inside and stored as JPEG so a page stays a few hundred kilobytes.
  private func page(of image: UIImage) -> PDFPage? {
    let a4 = CGSize(width: 595, height: 842)
    let landscape = image.size.width > image.size.height
    let size = landscape ? CGSize(width: a4.height, height: a4.width) : a4
    return PDFPage(
      image: image,
      options: [
        .mediaBox: CGRect(origin: .zero, size: size),
        .compressionQuality: 0.6,
      ]
    )
  }
}
