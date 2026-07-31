import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  directoryCreate: vi.fn(),
  delete: vi.fn(),
  downloadFileAsync: vi.fn(),
  write: vi.fn(),
  isAvailableAsync: vi.fn(),
  shareAsync: vi.fn(),
}));

class FakeFile {
  readonly uri: string;
  constructor(...segments: ReadonlyArray<{ uri: string } | string>) {
    this.uri = segments
      .map((segment) => (typeof segment === "string" ? segment : segment.uri))
      .join("/");
  }
  create = (options?: unknown) => mocks.create(this.uri, options);
  delete = () => mocks.delete(this.uri);
  write = (content: string, options?: unknown) => mocks.write(this.uri, content, options);
  static downloadFileAsync = (url: string, destination: FakeFile, options?: unknown) =>
    mocks.downloadFileAsync(url, destination, options);
}

class FakeDirectory {
  readonly uri: string;
  constructor(...segments: ReadonlyArray<{ uri: string } | string>) {
    this.uri = segments
      .map((segment) => (typeof segment === "string" ? segment : segment.uri))
      .join("/");
  }
  create = (options?: unknown) => mocks.directoryCreate(this.uri, options);
}

vi.mock("expo-file-system", () => ({
  Directory: FakeDirectory,
  File: FakeFile,
  Paths: { cache: { uri: "file:///cache" } },
}));

vi.mock("expo-sharing", () => ({
  isAvailableAsync: mocks.isAvailableAsync,
  shareAsync: mocks.shareAsync,
}));

import {
  SHARE_FAILED_MESSAGE,
  SHARING_UNAVAILABLE_MESSAGE,
  redactUri,
  shareImage,
} from "./fullScreenImageActions";

describe("redactUri", () => {
  it("reduces a data URI to its media type so bytes never reach a log", () => {
    expect(redactUri("data:image/png;base64,U0VDUkVU")).toBe("data:image/png");
    expect(redactUri("data:image/png;charset=utf-8;base64,U0VDUkVU")).toBe("data:image/png");
  });

  it("leaves ordinary URLs alone", () => {
    expect(redactUri("https://example.test/a.png")).toBe("https://example.test/a.png");
  });
});

describe("shareImage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAvailableAsync.mockResolvedValue(true);
    mocks.shareAsync.mockResolvedValue(undefined);
    mocks.downloadFileAsync.mockImplementation(async (_url, destination) => destination);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shares a local file directly and never deletes it", async () => {
    const result = await shareImage({ uri: "file:///tmp/shot.png" });

    expect(result).toEqual({ ok: true });
    expect(mocks.shareAsync).toHaveBeenCalledWith(
      "file:///tmp/shot.png",
      expect.objectContaining({ mimeType: "image/png", UTI: "public.png" }),
    );
    expect(mocks.downloadFileAsync).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it("writes a data URI to a temp file, shares it, then deletes it", async () => {
    const result = await shareImage({ uri: "data:image/png;base64,QUJD" });

    expect(result).toEqual({ ok: true });
    expect(mocks.write).toHaveBeenCalledWith(
      expect.stringContaining(".png"),
      "QUJD",
      expect.objectContaining({ encoding: "base64" }),
    );
    expect(mocks.delete).toHaveBeenCalledTimes(1);
  });

  it("handles data URIs carrying extra media-type parameters", async () => {
    const result = await shareImage({ uri: "data:image/png;charset=utf-8;base64,QUJD" });

    expect(result).toEqual({ ok: true });
    expect(mocks.write).toHaveBeenCalledWith(expect.anything(), "QUJD", expect.anything());
  });

  it("downloads a remote image, then cleans the temp file up", async () => {
    const result = await shareImage({ uri: "https://example.test/assets/a.png?revision=3" });

    expect(result).toEqual({ ok: true });
    expect(mocks.downloadFileAsync).toHaveBeenCalledWith(
      "https://example.test/assets/a.png?revision=3",
      expect.anything(),
      expect.anything(),
    );
    // The cache-buster must not be read as part of the extension.
    expect(mocks.shareAsync).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mimeType: "image/png" }),
    );
    expect(mocks.delete).toHaveBeenCalledTimes(1);
  });

  it("derives the temp file name from fileName, stripping any path", async () => {
    await shareImage({ uri: "https://example.test/a.png", fileName: "../../etc/logo.png" });

    expect(mocks.downloadFileAsync).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ uri: expect.stringContaining("logo.png") }),
      expect.anything(),
    );
  });

  it("reports when sharing is unavailable instead of throwing", async () => {
    mocks.isAvailableAsync.mockResolvedValue(false);

    const result = await shareImage({ uri: "file:///tmp/shot.png" });

    expect(result).toEqual({ ok: false, message: SHARING_UNAVAILABLE_MESSAGE });
    expect(mocks.shareAsync).not.toHaveBeenCalled();
  });

  it("reports a failure without logging image bytes, and still deletes the temp file", async () => {
    const logged: Array<unknown> = [];
    vi.spyOn(console, "error").mockImplementation((value: unknown) => {
      logged.push(value);
    });
    mocks.shareAsync.mockRejectedValue(new Error("sheet failed"));

    const result = await shareImage({ uri: "data:image/png;base64,U0VDUkVU" });

    expect(result).toEqual({ ok: false, message: SHARE_FAILED_MESSAGE });
    expect(mocks.delete).toHaveBeenCalledTimes(1);
    const serialized = logged.map((entry) => String((entry as Error).message)).join("\n");
    expect(serialized).not.toContain("U0VDUkVU");
    expect(serialized).toContain("data:image/png");
  });
});
