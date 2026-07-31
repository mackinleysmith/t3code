import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  alert: vi.fn(),
  shareImage: vi.fn(),
}));

vi.mock("react-native", () => ({
  Alert: { alert: mocks.alert },
}));

vi.mock("./fullScreenImageActions", () => ({
  shareImage: mocks.shareImage,
}));

import { shareImageExclusively } from "./useShareImage";

describe("shareImageExclusively", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ignores a second request while a sheet is already open", async () => {
    let release: (() => void) | undefined;
    mocks.shareImage.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ ok: true });
      }),
    );

    // Two different thumbnails long-pressed before the first sheet appears.
    const first = shareImageExclusively({ uri: "https://example.test/a.png" });
    const second = shareImageExclusively({ uri: "https://example.test/b.png" });

    expect(mocks.shareImage).toHaveBeenCalledTimes(1);

    release?.();
    await Promise.all([first, second]);
  });

  it("allows a new share once the previous one settles", async () => {
    mocks.shareImage.mockResolvedValue({ ok: true });

    await shareImageExclusively({ uri: "https://example.test/a.png" });
    await shareImageExclusively({ uri: "https://example.test/b.png" });

    expect(mocks.shareImage).toHaveBeenCalledTimes(2);
  });

  it("releases the guard when a share fails, and surfaces the message", async () => {
    mocks.shareImage.mockResolvedValue({ ok: false, message: "Couldn't share the image." });

    await shareImageExclusively({ uri: "https://example.test/a.png" });

    expect(mocks.alert).toHaveBeenCalledWith("Couldn't share the image.");

    mocks.shareImage.mockResolvedValue({ ok: true });
    await shareImageExclusively({ uri: "https://example.test/b.png" });

    expect(mocks.shareImage).toHaveBeenCalledTimes(2);
  });

  it("releases the guard when shareImage throws", async () => {
    mocks.shareImage.mockRejectedValue(new Error("boom"));

    await expect(shareImageExclusively({ uri: "https://example.test/a.png" })).rejects.toThrow();

    mocks.shareImage.mockResolvedValue({ ok: true });
    await shareImageExclusively({ uri: "https://example.test/b.png" });

    expect(mocks.shareImage).toHaveBeenCalledTimes(2);
  });
});
