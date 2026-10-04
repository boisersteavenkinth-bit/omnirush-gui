/**
 * Capture v2: what counts as a binary file. A binary file is never sent as
 * text (any decoding would replace bytes, and the text scrubber would rewrite
 * runs inside it); it goes to the byte-exact project archive instead.
 *
 * A file is binary when its name is a known binary type, when its first
 * bytes carry a known binary signature (a PDF stays a PDF even when every
 * byte of it happens to be ASCII), when its first 8 KiB hold a NUL or many
 * control bytes, or when it is not valid UTF-8 anywhere. Identical in the
 * CLI and the desktop app (see the parity vectors in
 * `__fixtures__/capture_v2_vectors.json`).
 */
import { isUtf8 } from "node:buffer";

/** Extensions (lower case, without the dot) whose content is binary whatever its bytes look like. */
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  // documents
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "epub", "rtfd", "pages", "numbers", "key",
  // images
  "png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "webp", "ico", "icns", "heic", "heif", "avif", "psd", "xcf", "raw", "cr2", "nef", "dng",
  // audio / video
  "mp3", "wav", "flac", "ogg", "oga", "m4a", "aac", "opus", "mp4", "m4v", "mov", "avi", "mkv", "webm", "wmv", "flv", "mid", "midi",
  // archives / compressed
  "zip", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "tar", "jar", "war", "ear", "whl", "egg", "apk", "aar", "ipa", "deb", "rpm", "dmg", "iso", "lz4", "br", "cab", "msi",
  // executables / objects / libraries
  "exe", "dll", "so", "dylib", "a", "lib", "o", "obj", "bin", "elf", "class", "pyc", "pyo", "pyd", "wasm", "node", "dex", "out",
  // data / models / databases
  "sqlite", "sqlite3", "db", "mdb", "accdb", "parquet", "feather", "arrow", "avro", "orc", "npy", "npz", "pkl", "pickle", "h5", "hdf5", "nc",
  "pt", "pth", "ckpt", "safetensors", "onnx", "tflite", "pb", "gguf", "joblib", "mat", "sav", "dta", "xlsb", "lockb",
  // fonts
  "ttf", "otf", "woff", "woff2", "eot",
  // 3d / design
  "blend", "fbx", "glb", "3ds", "max", "skp", "stl", "dwg", "sketch", "fig", "ai", "indd",
]);

/**
 * Leading signatures of binary formats (at offset 0 unless given). Short
 * printable ones (MZ, BZh, ID3) are left out: a text file may start so, and
 * the real files fail the control-byte or UTF-8 checks anyway.
 */
const SIGNATURES: ReadonlyArray<{ bytes: number[]; offset?: number }> = [
  { bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  { bytes: [0x89, 0x50, 0x4e, 0x47] }, // PNG
  { bytes: [0xff, 0xd8, 0xff] }, // JPEG
  { bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF8
  { bytes: [0x50, 0x4b, 0x03, 0x04] }, // ZIP (docx, jar, ...)
  { bytes: [0x50, 0x4b, 0x05, 0x06] }, // empty ZIP
  { bytes: [0x1f, 0x8b] }, // gzip
  { bytes: [0x28, 0xb5, 0x2f, 0xfd] }, // zstd
  { bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] }, // xz
  { bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] }, // 7z
  { bytes: [0x52, 0x61, 0x72, 0x21] }, // Rar!
  { bytes: [0x7f, 0x45, 0x4c, 0x46] }, // ELF
  { bytes: [0xcf, 0xfa, 0xed, 0xfe] }, // Mach-O 64
  { bytes: [0xce, 0xfa, 0xed, 0xfe] }, // Mach-O 32
  { bytes: [0xca, 0xfe, 0xba, 0xbe] }, // Mach-O fat / Java class
  { bytes: [0x00, 0x61, 0x73, 0x6d] }, // wasm
  { bytes: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66] }, // SQLite format
  { bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF (wav, webp, avi)
  { bytes: [0x4f, 0x67, 0x67, 0x53] }, // OggS
  { bytes: [0x66, 0x4c, 0x61, 0x43] }, // fLaC
  { bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 }, // ftyp (mp4, mov, heic)
  { bytes: [0x1a, 0x45, 0xdf, 0xa3] }, // Matroska / WebM
  { bytes: [0x49, 0x49, 0x2a, 0x00] }, // TIFF LE
  { bytes: [0x4d, 0x4d, 0x00, 0x2a] }, // TIFF BE
  { bytes: [0x00, 0x00, 0x01, 0x00] }, // ICO
  { bytes: [0x77, 0x4f, 0x46, 0x46] }, // wOFF
  { bytes: [0x77, 0x4f, 0x46, 0x32] }, // wOF2
  { bytes: [0x50, 0x41, 0x52, 0x31] }, // PAR1 (parquet)
  { bytes: [0x89, 0x48, 0x44, 0x46] }, // HDF5
  { bytes: [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59] }, // .npy
];

/** The lower-case extension of a path's last component ("" without one). */
export function pathExtension(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

/** Whether the path names a known binary type (its extension). */
export function isKnownBinaryPath(path: string): boolean {
  return BINARY_EXTENSIONS.has(pathExtension(path));
}

/** Whether `head` (the first bytes of a file) starts with a known binary signature. */
export function hasBinarySignature(head: Uint8Array): boolean {
  for (const signature of SIGNATURES) {
    const offset = signature.offset ?? 0;
    if (head.length < offset + signature.bytes.length) continue;
    let match = true;
    for (let index = 0; index < signature.bytes.length; index += 1) {
      if (head[offset + index] !== signature.bytes[index]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

/** Strict UTF-8 validation; with `partial`, an incomplete last character (a cut head) is allowed. */
export function isValidUtf8(buffer: Uint8Array, partial = false): boolean {
  if (isUtf8(buffer)) return true;
  if (!partial) return false;
  for (let back = 1; back <= 3 && back <= buffer.length; back += 1) {
    const byte = buffer[buffer.length - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return length > back && isUtf8(buffer.subarray(0, buffer.length - back));
  }
  return false;
}

/** A NUL, or more than 10% control bytes, in the first 8 KiB. */
export function hasBinaryControlBytes(buffer: Uint8Array): boolean {
  const length = Math.min(buffer.length, 8_192);
  let suspicious = 0;
  for (let index = 0; index < length; index += 1) {
    const byte = buffer[index]!;
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return length > 0 && suspicious / length > 0.1;
}

/**
 * Why a file is binary, or null for text. `path` may be null (content only);
 * `partial`: `buffer` is a head cut from a longer file.
 */
export function binaryReason(path: string | null, buffer: Uint8Array, partial = false): "type" | "signature" | "control" | "utf8" | null {
  if (path !== null && isKnownBinaryPath(path)) return "type";
  if (hasBinarySignature(buffer)) return "signature";
  if (hasBinaryControlBytes(buffer)) return "control";
  if (!isValidUtf8(buffer, partial)) return "utf8";
  return null;
}

export function isBinaryContent(path: string | null, buffer: Uint8Array, partial = false): boolean {
  return binaryReason(path, buffer, partial) !== null;
}
