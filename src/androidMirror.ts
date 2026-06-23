/**
 * Android screen mirror — the visual parallel to serve-sim's iOS MJPEG preview.
 * Android has no serve-sim, so we poll `adb exec-out screencap -p` and push PNG
 * frames to the renderer, which shows them in an <img> with a click/key input
 * layer that maps back to adb taps (coordinates scaled by the device's pixel size).
 *
 * The capture loop is sequential (await each frame before the next) so a slow
 * device throttles itself rather than piling up screencaps. exec is injected.
 */
import { execFile } from "node:child_process";
import { adbScreencapArgs, parseWmSize } from "./adb.ts";
import { adbBinary } from "./androidLog.ts";

export type BufExec = (cmd: string, args: string[]) => Promise<Buffer>;
export type StrExec = (cmd: string, args: string[]) => Promise<string>;

/** Device pixel size via `adb shell wm size` (for mapping a click in the scaled <img> back to device px). */
export async function deviceSize(serial: string, run: StrExec = strExec): Promise<{ width: number; height: number } | null> {
  return parseWmSize(await run(adbBinary(), [...(serial && serial !== "any" ? ["-s", serial] : []), "shell", "wm", "size"]));
}

export class AndroidScreenStream {
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly opts: {
      serial: string;
      /** Delivered a base64 PNG per frame. */
      onFrame: (base64: string) => void;
      /** Target gap between frames (ms). Default 350 (~3fps) — screencap is the bottleneck. */
      intervalMs?: number;
      exec?: BufExec;
    },
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  private async loop(): Promise<void> {
    const exec = this.opts.exec ?? bufExec;
    const args = adbScreencapArgs(this.opts.serial);
    while (this.running) {
      try {
        const buf = await exec(adbBinary(), args);
        if (this.running && buf.length) this.opts.onFrame(buf.toString("base64"));
      } catch {
        // device hiccup (reboot, transient adb error) — back off and retry, don't die.
        await this.sleep(1000);
      }
      await this.sleep(this.opts.intervalMs ?? 350);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => (this.timer = setTimeout(r, ms)));
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }
}

const bufExec: BufExec = (cmd, args) =>
  new Promise((resolve, reject) => execFile(cmd, args, { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }, (e, out) => (e ? reject(e) : resolve(out as Buffer))));

const strExec: StrExec = (cmd, args) =>
  new Promise((resolve, reject) => execFile(cmd, args, { maxBuffer: 1024 * 1024 }, (e, out) => (e ? reject(e) : resolve(out))));
