import ExpoModulesCore
import UIKit

public class LayoutMetricsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LayoutMetrics")

    View(LayoutObserverView.self) {
      Events("onMetricsChange")
    }
  }
}

/// An invisible view laid over the app that reports what a layout needs and
/// the window's size cannot say: the size class, and on a foldable iPhone
/// the hinge, as the region UIKit reserves for the fold, so no content is
/// placed across it.
final class LayoutObserverView: ExpoView {
  let onMetricsChange = EventDispatcher()
  private var lastMetrics: NSDictionary?
  /// Nil until UIKit has said whether there is a hinge, on a system that can.
  private var hasHinge: Bool? = false

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
    if #available(iOS 17.0, *) {
      registerForTraitChanges([UITraitHorizontalSizeClass.self]) {
        (view: LayoutObserverView, _: UITraitCollection) in
        view.publish()
      }
    }
    // The hinge APIs arrived in the iOS 27.1 SDK.
    #if canImport(UIKit, _version: 9127.0.85)
      if #available(iOS 27.1, *) {
        hasHinge = nil
        addInteraction(
          UIHingeInteraction { [weak self] _, update in
            guard let self, self.window != nil else { return }
            // Having a hinge is the device's; its angle does not change it.
            let hasHinge = self.hasHinge == true || update.hinge != nil
            guard self.hasHinge != hasHinge else { return }
            self.hasHinge = hasHinge
            self.publish()
          })
      }
    #endif
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    lastMetrics = nil
    // UIKit only reports a hinge where there is one, so silence means none.
    if window != nil, hasHinge == nil {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
        guard let self, self.window != nil, self.hasHinge == nil else { return }
        self.hasHinge = false
        self.publish()
      }
    }
    publish()
  }

  // Before iOS 17 the size class arrives here rather than by registration.
  override func traitCollectionDidChange(_ previous: UITraitCollection?) {
    super.traitCollectionDidChange(previous)
    if previous?.horizontalSizeClass != traitCollection.horizontalSizeClass {
      publish()
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    publish()
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    publish()
  }

  private func publish() {
    guard window != nil, bounds.width > 0, bounds.height > 0, let hasHinge else { return }
    var division: [String: CGFloat]?
    #if canImport(UIKit, _version: 9127.0.85)
      if #available(iOS 27.1, *) {
        for region in reservedRegions(kind: .division) where region.isActive {
          let frame = region.frame.intersection(bounds)
          guard !frame.isNull, !frame.isEmpty else { continue }
          division = [
            "x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height,
          ]
        }
      }
    #endif
    var metrics: [String: Any] = [
      "hasHinge": hasHinge,
      "horizontalSizeClass": traitCollection.horizontalSizeClass == .regular
        ? "regular" : "compact",
      "safeAreaLeft": safeAreaInsets.left,
      "safeAreaRight": safeAreaInsets.right,
    ]
    metrics["division"] = division
    let next = metrics as NSDictionary
    guard lastMetrics?.isEqual(next) != true else { return }
    lastMetrics = next
    onMetricsChange(metrics)
  }
}
