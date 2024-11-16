import os from "os"
import * as path from "path"

/*
The Node.js 'path' module resolves and normalizes paths differently depending on the platform:
- On Windows, it uses backslashes (\) as the default path separator.
- On POSIX-compliant systems (Linux, macOS), it uses forward slashes (/) as the default path separator.

While modules like 'upath' can be used to normalize paths to use forward slashes consistently,
this can create inconsistencies when interfacing with other modules (like vscode.fs) that use
backslashes on Windows.

Our approach:
1. We present paths with forward slashes to the AI and user for consistency.
2. We use the 'arePathsEqual' function for safe path comparisons.
3. Internally, Node.js gracefully handles both backslashes and forward slashes.

This strategy ensures consistent path presentation while leveraging Node.js's built-in
path handling capabilities across different platforms.

Note: When interacting with the file system or VS Code APIs, we still use the native path module
to ensure correct behavior on all platforms. The toPosixPath and arePathsEqual functions are
primarily used for presentation and comparison purposes, not for actual file system operations.

Observations:
- Macos isn't so flexible with mixed separators, whereas windows can handle both. ("Node.js does automatically handle path separators on Windows, converting forward slashes to backslashes as needed. However, on macOS and other Unix-like systems, the path separator is always a forward slash (/), and backslashes are treated as regular characters.")
*/

/**
 * Converts a given Windows file path to a POSIX file path by replacing backslashes with forward slashes.
 * If the path is an extended-length path (starts with "\\\\?\\"), it is returned unmodified to maintain its special syntax.
 *
 * @param p - The file path to convert.
 * @returns The converted POSIX file path, or the original path if it is an extended-length path.
 */
function toPosixPath(p: string) {
  // Extended-Length Paths in Windows start with "\\?\" to allow longer paths and bypass usual parsing. If detected, we return the path unmodified to maintain functionality, as altering these paths could break their special syntax.
  const isExtendedLengthPath = p.startsWith("\\\\?\\")

  if (isExtendedLengthPath) {
    return p
  }

  return p.replace(/\\/g, "/")
}

// Declaration merging allows us to add a new method to the String type
// You must import this file in your entry point (extension.ts) to have access at runtime
declare global {
  interface String {
    toPosix(): string
  }
}

String.prototype.toPosix = function (this: string): string {
  return toPosixPath(this)
}

/**
 * Compares two file paths to determine if they are equal.
 *
 * This function normalizes the paths before comparison. On Windows platforms,
 * the comparison is case-insensitive.
 *
 * @param path1 - The first path to compare. Optional.
 * @param path2 - The second path to compare. Optional.
 * @returns `true` if both paths are equal or both are undefined, `false` otherwise.
 */
export function arePathsEqual(path1?: string, path2?: string): boolean {
  if (!path1 && !path2) {
    return true
  }
  if (!path1 || !path2) {
    return false
  }

  path1 = normalizePath(path1)
  path2 = normalizePath(path2)

  if (process.platform === "win32") {
    return path1.toLowerCase() === path2.toLowerCase()
  }
  return path1 === path2
}

/**
 * Normalizes a given path by resolving `./..` segments, removing duplicate slashes,
 * and standardizing path separators. Additionally, it removes trailing slashes,
 * except for root paths.
 *
 * @param p - The path to normalize.
 * @returns The normalized path.
 */
function normalizePath(p: string): string {
  // normalize resolve ./.. segments, removes duplicate slashes, and standardizes path separators
  let normalized = path.normalize(p)
  // however it doesn't remove trailing slashes
  // remove trailing slash, except for root paths
  if (normalized.length > 1 && (normalized.endsWith("/") || normalized.endsWith("\\"))) {
    normalized = normalized.slice(0, -1)
  }
  return normalized
}

/**
 * Generates a readable path based on the current working directory (cwd) and an optional relative path.
 *
 * @param cwd - The current working directory.
 * @param relPath - An optional relative path. Defaults to an empty string if not provided.
 * @returns A string representing the readable path.
 *
 * The function resolves the relative path to an absolute path using the cwd. If the cwd is the user's Desktop,
 * it returns the full absolute path. If the absolute path is the same as the cwd, it returns the basename of the path.
 * Otherwise, it returns the relative path to the cwd. If the absolute path is outside the cwd, it returns the absolute path.
 */
export function getReadablePath(cwd: string, relPath?: string): string {
  relPath = relPath || ""
  // path.resolve is flexible in that it will resolve relative paths like '../../' to the cwd and even ignore the cwd if the relPath is actually an absolute path
  const absolutePath = path.resolve(cwd, relPath)
  if (arePathsEqual(cwd, path.join(os.homedir(), "Desktop"))) {
    // User opened vscode without a workspace, so cwd is the Desktop. Show the full absolute path to keep the user aware of where files are being created
    return absolutePath.toPosix()
  }
  if (arePathsEqual(path.normalize(absolutePath), path.normalize(cwd))) {
    return path.basename(absolutePath).toPosix()
  } else {
    // show the relative path to the cwd
    const normalizedRelPath = path.relative(cwd, absolutePath)
    if (absolutePath.includes(cwd)) {
      return normalizedRelPath.toPosix()
    } else {
      // we are outside the cwd, so show the absolute path (useful for when codey passes in '../../' for example)
      return absolutePath.toPosix()
    }
  }
}
