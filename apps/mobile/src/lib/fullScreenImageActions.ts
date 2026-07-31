import * as Schema from "effect/Schema";
import * as Sharing from "expo-sharing";
import type { ImageURISource } from "react-native";

export type FullScreenImageSource = {
  readonly uri: string;
  readonly fileName?: string;
  /** Forwarded to `react-native-image-viewing`'s underlying `Image` source. */
  readonly cache?: ImageURISource["cache"];
};

export type ImageActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export const SHARING_UNAVAILABLE_MESSAGE = "Sharing isn't available on this device.";
export const SHARE_FAILED_MESSAGE = "Couldn't share the image.";

export class ImageShareError extends Schema.TaggedErrorClass<ImageShareError>()("ImageShareError", {
  uri: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to share the image at ${this.uri}.`;
  }
}

const CACHE_DIRECTORY_NAME = "fullscreen-image-share";
const DATA_URI_PATTERN = /^data:([^;,]*)(?:;[^;,=]+=[^;,]+)*(?:(;base64))?,/i;

/** iOS needs a UTI alongside the mime type for the sheet to offer the right targets. */
const IMAGE_TYPES: ReadonlyArray<{
  readonly extension: string;
  readonly mimeType: string;
  readonly uti: string;
}> = [
  { extension: "png", mimeType: "image/png", uti: "public.png" },
  { extension: "jpg", mimeType: "image/jpeg", uti: "public.jpeg" },
  { extension: "jpeg", mimeType: "image/jpeg", uti: "public.jpeg" },
  { extension: "gif", mimeType: "image/gif", uti: "com.compuserve.gif" },
  { extension: "webp", mimeType: "image/webp", uti: "org.webmproject.webp" },
  { extension: "heic", mimeType: "image/heic", uti: "public.heic" },
  { extension: "bmp", mimeType: "image/bmp", uti: "com.microsoft.bmp" },
];

type ImageType = (typeof IMAGE_TYPES)[number];

let temporaryFileCounter = 0;

/** `data:` URIs *are* the image bytes, so they are never logged verbatim. */
export function redactUri(uri: string): string {
  const match = DATA_URI_PATTERN.exec(uri);
  return match === null ? uri : `data:${match[1] || "application/octet-stream"}`;
}

function imageTypeFor(uri: string): ImageType | null {
  const dataMatch = DATA_URI_PATTERN.exec(uri);
  if (dataMatch !== null) {
    const mimeType = dataMatch[1]?.toLowerCase();
    return IMAGE_TYPES.find((type) => type.mimeType === mimeType) ?? null;
  }

  // Only the last path segment, so dots in the hostname are not read as an extension.
  const lastSegment = (uri.split(/[?#]/, 1)[0] ?? "").split("/").pop() ?? "";
  const dotIndex = lastSegment.lastIndexOf(".");
  if (dotIndex <= 0) {
    return null;
  }
  const extension = lastSegment.slice(dotIndex + 1).toLowerCase();
  return IMAGE_TYPES.find((type) => type.extension === extension) ?? null;
}

/** Returns "" when nothing usable is left, so the caller falls back to the counter. */
function sanitizeFileNameStem(fileName: string): string {
  const withoutDirectories = fileName.split(/[\\/]/).pop() ?? "";
  const dotIndex = withoutDirectories.lastIndexOf(".");
  const stem = dotIndex > 0 ? withoutDirectories.slice(0, dotIndex) : withoutDirectories;
  return stem.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|-+$/g, "");
}

function temporaryFileName(source: FullScreenImageSource): string {
  const extension = imageTypeFor(source.uri)?.extension ?? "img";
  const stem = source.fileName ? sanitizeFileNameStem(source.fileName) : "";
  if (stem.length > 0) {
    return `${stem}.${extension}`;
  }
  temporaryFileCounter += 1;
  return `image-${temporaryFileCounter}.${extension}`;
}

function isLocalFileUri(uri: string): boolean {
  return uri.startsWith("file://") || uri.startsWith("/");
}

async function cacheDirectory() {
  const { Directory, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.cache, CACHE_DIRECTORY_NAME);
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

function deleteQuietly(file: { delete: () => void }): void {
  try {
    file.delete();
  } catch {
    // A leftover file in the cache directory is harmless; the OS reclaims it.
  }
}

type MaterializedImage = {
  readonly file: { readonly uri: string; delete: () => void };
  /** True when we created the file and are therefore responsible for removing it. */
  readonly ownsTemporaryFile: boolean;
};

/** `Sharing.shareAsync` only accepts a local file, so remote and data URIs land on disk first. */
async function materializeImageFile(source: FullScreenImageSource): Promise<MaterializedImage> {
  const { File } = await import("expo-file-system");

  const dataMatch = DATA_URI_PATTERN.exec(source.uri);
  if (dataMatch !== null) {
    if (dataMatch[2] === undefined) {
      throw new Error("Only base64-encoded data URIs are supported.");
    }
    const file = new File(await cacheDirectory(), temporaryFileName(source));
    file.create({ overwrite: true });
    file.write(source.uri.slice(dataMatch[0].length), { encoding: "base64" });
    return { file, ownsTemporaryFile: true };
  }

  if (isLocalFileUri(source.uri)) {
    return { file: new File(source.uri), ownsTemporaryFile: false };
  }

  const destination = new File(await cacheDirectory(), temporaryFileName(source));
  const downloaded = await File.downloadFileAsync(source.uri, destination, {
    idempotent: true,
  });
  return { file: downloaded, ownsTemporaryFile: true };
}

export async function shareImage(source: FullScreenImageSource): Promise<ImageActionResult> {
  let materialized: MaterializedImage | null = null;
  try {
    if (!(await Sharing.isAvailableAsync())) {
      return { ok: false, message: SHARING_UNAVAILABLE_MESSAGE };
    }

    materialized = await materializeImageFile(source);
    const imageType = imageTypeFor(source.uri);

    // Resolves only after the sheet is dismissed, so the file outlives every read.
    await Sharing.shareAsync(materialized.file.uri, {
      dialogTitle: source.fileName,
      mimeType: imageType?.mimeType,
      UTI: imageType?.uti,
    });

    return { ok: true };
  } catch (cause) {
    console.error(new ImageShareError({ uri: redactUri(source.uri), cause }));
    return { ok: false, message: SHARE_FAILED_MESSAGE };
  } finally {
    if (materialized?.ownsTemporaryFile) {
      deleteQuietly(materialized.file);
    }
  }
}
