import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

export function sha256File(absPath: string): string {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
}

/**
 * Resolve a repo-relative path and confirm it is a regular file inside
 * `areaDir` (no symlinks, no `..` escapes).
 */
export function resolveInside(repoRoot: string, areaDir: string, relPath: string): { ok: true; abs: string } | { ok: false; reason: string } {
  if (path.isAbsolute(relPath)) return { ok: false, reason: `${relPath}: absolute paths are not allowed` };
  const abs = path.resolve(repoRoot, relPath);
  let stat;
  try {
    stat = lstatSync(abs);
  } catch {
    return { ok: false, reason: `${relPath}: file does not exist` };
  }
  if (stat.isSymbolicLink()) return { ok: false, reason: `${relPath}: symbolic links are not allowed` };
  if (!stat.isFile()) return { ok: false, reason: `${relPath}: not a regular file` };
  const realArea = realpathSync(path.resolve(repoRoot, areaDir));
  const real = realpathSync(abs);
  if (!real.startsWith(realArea + path.sep)) return { ok: false, reason: `${relPath}: outside ${areaDir}/` };
  return { ok: true, abs: real };
}
