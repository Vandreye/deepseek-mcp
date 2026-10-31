import fs from "node:fs";
import path from "node:path";
import { WORKSPACE_DIR_NAME } from "../config.js";

export class PathError extends Error {}

export interface SafePath {
  abs: string;
  /** Workspace-relative path with forward slashes ("" = workspace root). */
  rel: string;
}

/** Real (symlink-free) absolute path of a workspace folder. */
export function realWorkspace(ws: string): string {
  const abs = path.resolve(ws);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new PathError(`Workspace does not exist: ${abs}`);
  }
  if (!st.isDirectory()) throw new PathError(`Workspace is not a folder: ${abs}`);
  const real = fs.realpathSync.native(abs);
  const parsed = path.parse(real);
  if (real === parsed.root) throw new PathError("Refusing to use a drive/filesystem root as the workspace.");
  if (path.relative(real, process.env.USERPROFILE || process.env.HOME || "") === "") {
    throw new PathError("Refusing to use your home folder itself as the workspace. Pick a project folder.");
  }
  return real;
}

const SECRET_NAME = /^(\.env(\..+)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.pypirc|\.netrc|credentials(\.json)?)$/i;
const SECRET_EXT = /\.(pem|key|p12|pfx|keystore|jks)$/i;
const SECRET_OK = /^\.env\.(example|sample|template)$/i;

/** True for files that look like secrets. These never go to DeepSeek. */
export function isSecretFile(rel: string): boolean {
  const base = rel.split("/").pop() ?? "";
  if (SECRET_OK.test(base)) return false;
  return SECRET_NAME.test(base) || SECRET_EXT.test(base);
}

/**
 * Resolve a path given by DeepSeek. Throws unless it stays inside the workspace
 * (after following symlinks) and is not a protected location.
 */
export function resolveSafe(wsReal: string, p: string, mode: "read" | "write"): SafePath {
  if (typeof p !== "string" || p.trim() === "") throw new PathError("Path is empty.");
  if (p.includes("\0")) throw new PathError("Invalid path.");
  const abs = path.resolve(wsReal, p.trim());

  // Follow symlinks on the part of the path that exists.
  let cur = abs;
  const rest: string[] = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  let real: string;
  try {
    real = path.join(fs.realpathSync.native(cur), ...rest);
  } catch {
    throw new PathError(`Cannot resolve path: ${p}`);
  }

  const relNative = path.relative(wsReal, real);
  if (relNative.startsWith("..") || path.isAbsolute(relNative)) {
    throw new PathError(`Path is outside the workspace: ${p}`);
  }
  const rel = relNative.split(path.sep).join("/");
  const segments = rel.split("/").map((s) => s.toLowerCase());

  if (segments.includes(".git")) throw new PathError("The .git folder is off limits (use git commands instead).");
  if (segments.includes(WORKSPACE_DIR_NAME)) throw new PathError(`The ${WORKSPACE_DIR_NAME} folder is off limits.`);
  if (rel !== "" && isSecretFile(rel)) throw new PathError(`Blocked: ${rel} looks like a secrets file.`);
  if (mode === "write" && rel === "") throw new PathError("Cannot write to the workspace root itself.");

  return { abs: real, rel };
}
