import { useCallback } from "react";
import { Alert } from "react-native";

import { shareImage, type FullScreenImageSource } from "./fullScreenImageActions";

// Module scope, not per hook. The hook is called once per thumbnail and again
// by the fullscreen viewer, so a ref would guard each caller separately and
// still let two long-presses stack two system sheets.
//
// Held as a start time rather than a boolean so the lock expires on its own. A
// share sheet that never settles would otherwise disable sharing app-wide until
// the app restarts, which is a worse failure than the stacking it prevents.
const SHARE_LOCK_TIMEOUT_MS = 60_000;
let shareStartedAt: number | null = null;

/** Exported for tests. The hook is a thin wrapper around this. */
export async function shareImageExclusively(source: FullScreenImageSource): Promise<void> {
  const startedAt = Date.now();
  if (shareStartedAt !== null && startedAt - shareStartedAt < SHARE_LOCK_TIMEOUT_MS) {
    return;
  }
  shareStartedAt = startedAt;
  try {
    const result = await shareImage(source);
    if (!result.ok) {
      Alert.alert(result.message);
    }
  } finally {
    shareStartedAt = null;
  }
}

/** Opens the system share sheet for an image, one at a time across the app. */
export function useShareImage() {
  return useCallback((source: FullScreenImageSource) => {
    void shareImageExclusively(source);
  }, []);
}
