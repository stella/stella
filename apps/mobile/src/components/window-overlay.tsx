import { Platform, StyleSheet, View } from "react-native";
import { FullWindowOverlay } from "react-native-screens";

/**
 * The one way to draw over every screen, as the run banners do. On iOS the
 * native stack's bars, modals and sheets are UIKit views that a view of the
 * app's own never rises above, whatever its place in the tree: drawn beside
 * the stack, a banner slides under the header's buttons and behind a modal.
 * Here it is drawn in a layer of the window above them all. On Android the
 * stack draws inside the app's own view tree, so a view after it is on top
 * already. Either way, a touch that misses the content reaches the screen
 * beneath.
 */
export const WindowOverlay = ({ children }: React.PropsWithChildren) =>
  Platform.OS === "ios" ? (
    <FullWindowOverlay>{children}</FullWindowOverlay>
  ) : (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      {children}
    </View>
  );
