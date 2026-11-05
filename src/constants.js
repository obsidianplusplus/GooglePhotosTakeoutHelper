/**
 * 项目公共常量。
 *
 * 行为基线来自 Python v4.1 参考实现（移植后已从本仓库移除）；Node 侧使用
 * Set 而不是 frozenset，字母大小写规则保持不变（扩展名一律带前导点、小写）。
 */

import os from "node:os";
import path from "node:path";

export const APP_NAME = "Google Photos Takeout Helper";
export const APP_DISPLAY_NAME = "PhotoTakeout Studio";
export const APP_VERSION = "5.0.0";

// 原版支持的“编辑后副本”后缀；匹配前统一转为小写和 NFC。
export const EXTRA_SUFFIXES = Object.freeze([
  "-edited",
  "-effects",
  "-smile",
  "-mix",
  "-edytowane",
  "-bearbeitet",
  "-bewerkt",
  "-編集済み",
  "-modificato",
  "-modifié",
  "-ha editado",
  "-editat",
]);

// mimetypes 在不同系统上的数据库并不一致，因此显式补齐常见媒体扩展名。
export const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".jpe",
  ".png",
  ".gif",
  ".bmp",
  ".tif",
  ".tiff",
  ".webp",
  ".heic",
  ".heif",
  ".avif",
  ".dng",
  ".raw",
  ".cr2",
  ".cr3",
  ".nef",
  ".arw",
  ".orf",
  ".rw2",
  ".pef",
  ".srw",
  ".raf",
  ".ico",
]);

export const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".m4v",
  ".mov",
  ".avi",
  ".mkv",
  ".webm",
  ".wmv",
  ".flv",
  ".3gp",
  ".3g2",
  ".mts",
  ".m2ts",
  ".mpeg",
  ".mpg",
  ".vob",
  ".ts",
  ".ogv",
  ".asf",
]);

export const MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);

export const DEFAULT_ALL_PHOTOS_FOLDER = "ALL_PHOTOS";
export const DEFAULT_UNKNOWN_DATE_FOLDER = "date-unknown";
export const DEFAULT_REPORT_NAME = "gpth-run-report.json";
export const ALBUM_INFO_NAME = "albums-info.json";

// EXIF 读取只需解析图像头部，但某些解码器仍会展开数据；保留合理上限以规避坏文件。
export const DEFAULT_MAX_EXIF_BYTES = 256 * 1024 * 1024;
export const DEFAULT_HASH_CHUNK_SIZE = 4 * 1024 * 1024;

/** 返回跨平台的用户设置文件路径（Python settings_path() 的 Node 版）。 */
export function settingsPath() {
  let root;
  if (process.platform === "win32") {
    root = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  } else if (process.platform === "darwin") {
    root = path.join(os.homedir(), "Library", "Application Support");
  } else {
    root = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  }
  return path.join(root, "GooglePhotosTakeoutHelper", "settings.json");
}

/** 扫描指纹缓存的默认路径（与设置文件同目录）。 */
export function scanCachePath() {
  return path.join(path.dirname(settingsPath()), "scan-cache-v1.json");
}
