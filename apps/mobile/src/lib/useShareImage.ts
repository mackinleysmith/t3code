import { useCallback, useRef } from "react";
import { Alert } from "react-native";

import { shareImage, type FullScreenImageSource } from "./fullScreenImageActions";

/**
 * Opens the system share sheet for an image, ignoring further presses until
 * the current one settles so a double press cannot stack two sheets.
 */
export function useShareImage() {
  const sharingRef = useRef(false);

  return useCallback((source: FullScreenImageSource) => {
    if (sharingRef.current) {
      return;
    }
    sharingRef.current = true;
    void shareImage(source)
      .then((result) => {
        if (!result.ok) {
          Alert.alert(result.message);
        }
      })
      .finally(() => {
        sharingRef.current = false;
      });
  }, []);
}
