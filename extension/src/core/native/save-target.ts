/**
 * Turn the path Chrome chose for a download into the folder and base name yt-dlp writes to.
 * Pure: unit-tested.
 */

import { parseSaveTarget, type SaveTarget } from "@host/protocol";

export function saveTargetFromPath(path: string): SaveTarget | null {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (cut <= 0) return null;
  let dir = path.slice(0, cut);
  // "C:" alone is "the current folder of drive C", not its root.
  if (/^[A-Za-z]:$/.test(dir)) dir += path[cut];
  const file = path.slice(cut + 1);
  // yt-dlp adds the real extension of what it downloads.
  const name = file.replace(/\.[A-Za-z0-9]{1,5}$/, "");
  return parseSaveTarget({ dir, name });
}
