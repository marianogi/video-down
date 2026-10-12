/**
 * Parse the machine-readable lines we ask yt-dlp to print, and turn them into
 * an overall percentage across all parts of a merged download (video + audio).
 *
 * Pure: unit-tested without spawning yt-dlp.
 */

/** Printed through `--progress-template`. Fields separated by "|", missing values are "NA". */
export const PROGRESS_PREFIX = "VDPROG ";
export const PROGRESS_TEMPLATE =
  "download:VDPROG %(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s";

/** Printed through `--print before_dl:...` with the format ids that will be downloaded ("299+140"). */
export const FORMAT_PREFIX = "VDFMT ";
/** Printed through `--print after_move:...` with the final path. */
export const FILE_PREFIX = "VDFILE ";

export interface ProgressSample {
  status: string;
  downloaded?: number;
  total?: number;
  speed?: number;
  eta?: number;
}

function num(value: string | undefined): number | undefined {
  if (value === undefined || value === "NA" || value === "None" || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function parseProgressLine(line: string): ProgressSample | null {
  if (!line.startsWith(PROGRESS_PREFIX)) return null;
  const [status, downloaded, total, estimate, speed, eta] = line
    .slice(PROGRESS_PREFIX.length)
    .trim()
    .split("|");
  if (!status) return null;
  const sample: ProgressSample = { status };
  const d = num(downloaded);
  const t = num(total) ?? num(estimate);
  const s = num(speed);
  const e = num(eta);
  if (d !== undefined) sample.downloaded = d;
  if (t !== undefined) sample.total = t;
  if (s !== undefined) sample.speed = s;
  if (e !== undefined) sample.eta = e;
  return sample;
}

/**
 * Tracks progress across the N parts of a download. yt-dlp downloads the parts
 * one after another and reports each with its own byte counters.
 */
export class ProgressTracker {
  private parts = 1;
  private finishedParts = 0;
  private lastFraction = 0;
  private lastStatusFinished = false;

  setFormatIds(formatIds: string): void {
    const count = formatIds.trim().split("+").filter(Boolean).length;
    this.parts = Math.max(1, count);
  }

  /** Feed a sample; returns the overall percentage 0-100. */
  update(sample: ProgressSample): number {
    if (sample.status === "finished") {
      if (!this.lastStatusFinished) {
        this.finishedParts = Math.min(this.parts, this.finishedParts + 1);
      }
      this.lastStatusFinished = true;
      this.lastFraction = 0;
    } else {
      this.lastStatusFinished = false;
      if (sample.total && sample.total > 0 && sample.downloaded !== undefined) {
        this.lastFraction = Math.min(1, sample.downloaded / sample.total);
      }
    }
    return this.percent();
  }

  percent(): number {
    const value = ((this.finishedParts + this.lastFraction) / this.parts) * 100;
    return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
  }

  allPartsFinished(): boolean {
    return this.finishedParts >= this.parts;
  }
}

/** Pull the most useful line out of yt-dlp's stderr for the UI. */
export function summariseError(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const error = [...lines].reverse().find((l) => l.startsWith("ERROR:"));
  const chosen = error ?? lines[lines.length - 1] ?? "yt-dlp failed";
  return chosen.replace(/^ERROR:\s*/, "").slice(0, 500);
}
