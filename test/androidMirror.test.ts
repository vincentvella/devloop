import { expect, test } from "bun:test";
import { AndroidScreenStream, type BufExec, deviceSize, type StrExec } from "../src/androidMirror.ts";

// --- deviceSize -----------------------------------------------------------

test("deviceSize parses `wm size` via the injected exec", async () => {
  const run: StrExec = async () => "Physical size: 1080x1920\n";
  expect(await deviceSize("emulator-5554", run)).toEqual({ width: 1080, height: 1920 });
});

test("deviceSize prefers an Override size over Physical", async () => {
  const run: StrExec = async () => "Physical size: 1080x1920\nOverride size: 720x1280\n";
  expect(await deviceSize("emulator-5554", run)).toEqual({ width: 720, height: 1280 });
});

test("deviceSize returns null when the output isn't parseable", async () => {
  const run: StrExec = async () => "adb: no devices/emulators found\n";
  expect(await deviceSize("emulator-5554", run)).toBeNull();
});

// --- AndroidScreenStream --------------------------------------------------

test("AndroidScreenStream delivers base64 PNG frames from exec", async () => {
  const frames: string[] = [];
  let seen!: () => void;
  const got = new Promise<void>((r) => (seen = r));
  const exec: BufExec = async () => Buffer.from("PNGDATA");
  const s = new AndroidScreenStream({
    serial: "emu",
    intervalMs: 1,
    exec,
    onFrame: (b) => {
      frames.push(b);
      seen();
    },
  });
  s.start();
  await got;
  s.stop();
  expect(frames[0]).toBe(Buffer.from("PNGDATA").toString("base64"));
});

test("start() is idempotent — a second call doesn't launch a second capture loop", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  // The loop invokes exec synchronously up to the first await, so after one start()
  // exec has been called exactly once; a second start() must be a no-op.
  const exec: BufExec = async () => {
    calls++;
    await gate;
    return Buffer.from("");
  };
  const s = new AndroidScreenStream({ serial: "emu", intervalMs: 1, exec, onFrame: () => {} });
  s.start();
  s.start();
  expect(calls).toBe(1);
  release();
  s.stop();
});

test("stop() before a capture completes suppresses that frame", async () => {
  let deliver!: (b: Buffer) => void;
  const gate = new Promise<Buffer>((r) => (deliver = r));
  let frames = 0;
  const exec: BufExec = () => gate;
  const s = new AndroidScreenStream({ serial: "emu", intervalMs: 1, exec, onFrame: () => frames++ });
  s.start(); // enters exec, awaiting the gate
  s.stop(); // running=false before the frame resolves
  deliver(Buffer.from("PNG"));
  await Promise.resolve();
  await Promise.resolve();
  expect(frames).toBe(0); // `if (this.running && buf.length)` gates it out
});

test(
  "a capture error backs off and the loop recovers instead of dying",
  async () => {
    let n = 0;
    let seen!: () => void;
    const got = new Promise<void>((r) => (seen = r));
    const exec: BufExec = async () => {
      n++;
      if (n === 1) throw new Error("adb hiccup"); // first frame fails → back off, retry
      return Buffer.from("RECOVERED");
    };
    const frames: string[] = [];
    const s = new AndroidScreenStream({
      serial: "emu",
      intervalMs: 1,
      exec,
      onFrame: (b) => {
        frames.push(b);
        seen();
      },
    });
    s.start();
    await got; // only resolves once the post-back-off retry succeeds
    s.stop();
    expect(n).toBeGreaterThanOrEqual(2); // retried after the error
    expect(frames[0]).toBe(Buffer.from("RECOVERED").toString("base64"));
  },
  { timeout: 5000 }, // the back-off is ~1000ms
);
