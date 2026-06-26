/**
 * Android device integration: native logs (`adb logcat`) and screenshots
 * (`adb exec-out screencap -p`) — the Android parallel to iosSimulator.ts. Native
 * logs land on the timeline as a `native` source, correlated with the JS console
 * the RN controller captures over CDP. Pure arg builders + parsing live in adb.ts
 * (unit-tested); the live spawn/exec is injected so CI needs no emulator.
 */
import { execFile, spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { adbLogcatArgs, adbScreencapArgs, parseLogcatLine } from "./adb.ts";
import type { LogBuffer } from "./logBuffer.ts";

/**
 * Resolve the `adb` binary. The Android SDK's platform-tools often isn't on a GUI
 * app's imported login-shell PATH, so fall back to the standard SDK locations.
 */
export function adbBinary(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || homedir();
  const roots = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, join(home, "Library/Android/sdk"), join(home, "Android/Sdk")];
  for (const root of roots) {
    if (!root) continue;
    const p = join(root, "platform-tools", "adb");
    if (existsSync(p)) return p;
  }
  return "adb"; // assume PATH
}

interface LineProc {
  stdout: { on(ev: "data", cb: (chunk: Buffer | string) => void): void } | null;
  kill(): void;
}
export type SpawnLike = (cmd: string, args: string[]) => LineProc;

/**
 * Streams an Android device's native logs (logcat) onto the buffer as a `native`
 * source. `spawn` is injectable for tests.
 */
export class AndroidLogStream {
  private proc?: LineProc;
  private partial = "";

  constructor(
    private readonly buffer: LogBuffer,
    private readonly opts: { serial: string; spawn?: SpawnLike; target?: string; adb?: string },
  ) {}

  start(): void {
    const spawn = this.opts.spawn ?? ((cmd, args) => nodeSpawn(cmd, args) as unknown as LineProc);
    this.proc = spawn(this.opts.adb ?? adbBinary(), adbLogcatArgs(this.opts.serial));
    this.proc.stdout?.on("data", (chunk) => this.onData(chunk.toString()));
  }

  /** Visible for tests: feed raw stdout through the line splitter + parser. */
  onData(chunk: string): void {
    this.partial += chunk;
    const lines = this.partial.split("\n");
    this.partial = lines.pop() ?? "";
    for (const line of lines) {
      const parsed = parseLogcatLine(line);
      if (parsed)
        this.buffer.push(
          "native",
          parsed.level,
          parsed.message,
          parsed.process ? { process: parsed.process } : undefined,
          this.opts.target,
        );
    }
  }

  stop(): void {
    this.proc?.kill();
    this.proc = undefined;
  }
}

/** Capture an Android screenshot as base64 PNG (screencap -p streams bytes to stdout). */
export function captureAdbScreenshot(
  serial: string,
  run: (cmd: string, args: string[]) => Promise<Buffer> = defaultRun,
): Promise<{ base64: string; mimeType: string }> {
  return run(adbBinary(), adbScreencapArgs(serial)).then((buf) => ({
    base64: buf.toString("base64"),
    mimeType: "image/png",
  }));
}

function defaultRun(cmd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout as Buffer),
    );
  });
}
