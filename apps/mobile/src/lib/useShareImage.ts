import { useCallback } from "react";
import { Alert } from "react-native";

import { shareImage, type FullScreenImageSource } from "./fullScreenImageActions";

// Module scope, not per hook. The hook is called once per thumbnail and again
// by the fullscreen viewer, so a ref would guard each caller separately and
// still let two long-presses stack two system sheets.
let sharing = false;

/** Exported for tests. The hook is a thin wrapper around this. */
export async function shareImageExclusively(source: FullScreenImageSource): Promise<void> {
  if (sharing) {
    return;
  }
  sharing = true;
  try {
    const result = await shareImage(source);
    if (!result.ok) {
      Alert.alert(result.message);
    }
  } finally {
    sharing = false;
  }
}

/** Opens the system share sheet for an image, one at a time across the app. */
export function useShareImage() {
  return useCallback((source: FullScreenImageSource) => {
    void shareImageExclusively(source);
  }, []);
}
