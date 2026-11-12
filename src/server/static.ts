import { createReadStream, type Stats } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

/**
 * Отдаёт файл из папки root. Возвращает false, если файла нет, тип не из списка
 * или путь пытается выйти за пределы root (например, ..%2f..%2fpackage.json).
 */
export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  relativePath: string,
): Promise<boolean> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(relativePath);
  } catch {
    return false;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) {
    return false;
  }
  const base = path.resolve(root);
  const file = path.resolve(base, decoded);
  if (!file.startsWith(base + path.sep)) {
    return false;
  }
  const type = CONTENT_TYPES[path.extname(file).toLowerCase()];
  if (type === undefined) {
    return false;
  }
  let info: Stats;
  try {
    info = await stat(file);
  } catch {
    return false;
  }
  if (!info.isFile()) {
    return false;
  }
  const etag = `W/"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`;
  res.setHeader("etag", etag);
  res.setHeader("cache-control", "no-cache");
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304);
    res.end();
    return true;
  }
  res.writeHead(200, { "content-type": type, "content-length": info.size });
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  await pipeline(createReadStream(file), res);
  return true;
}
