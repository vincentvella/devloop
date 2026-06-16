/**
 * Native build runner (item 13b). Spawns `expo run:<platform>` for a project,
 * streams its output onto the timeline (source `server`, stream `build`), and on
 * success records the project's @expo/fingerprint hash so we can later tell when
 * the installed binary has drifted from the JS (see nativeBuild.ts).
 *
 * Shells out, so it's exercised live (scripts/rn-harness / a real build) rather
 * than in CI. The pure command derivation is in nativeBuild.ts (unit-tested);
 * the only pure bit here is the fingerprint eval args.
 */
import { spawn, execFile } from "node:child_process";
import type { LogBuffer } from "./logBuffer.ts";
import { buildCommand, type Platform } from "./nativeBuild.ts";
import { setProjectFingerprint } from "./registry.ts";

/**
 * Node `-e` args that compute a project's fingerprint using the project's OWN
 * installed @expo/fingerprint (version-agnostic). Root passed via env to avoid
 * interpolating a path into the eval string. Prints just the hash; exits 3 if
 * the package isn't resolvable.
 */
export function fingerprintNodeArgs(): string[] {
  return [
    "-e",
    "const p=process.env.DL_FP_ROOT;" +
      "require(require.resolve('@expo/fingerprint',{paths:[p]}))" +
      ".createFingerprintAsync(p).then(r=>process.stdout.write(r.hash)).catch(()=>process.exit(3))",
  ];
}

/** Compute a project's native fingerprint hash, or null if it can't be computed. */
export function computeFingerprint(
  projectRoot: string,
  run: (cmd: string, args: string[], cwd: string, env: Record<string, string>) => Promise<string> = defaultNodeRun,
): Promise<string | null> {
  return run("node", fingerprintNodeArgs(), projectRoot, { DL_FP_ROOT: projectRoot })
    .then((out) => out.trim() || null)
    .catch(() => null);
}

function defaultNodeRun(cmd: string, args: string[], cwd: string, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });
}

export interface BuildHandle {
  /** Resolves when the build process exits. */
  done: Promise<{ ok: boolean; code: number | null; fingerprint?: string | null }>;
  cancel(): void;
}

/**
 * Build + install + launch a native dev build, streaming output to the timeline.
 * On success, records the project's fingerprint as the staleness baseline.
 */
export function runNativeBuild(opts: {
  buffer: LogBuffer;
  projectRoot: string;
  platform: Platform;
  /** Test seam — defaults to node child_process spawn. */
  spawnImpl?: typeof spawn;
}): BuildHandle {
  const { buffer, projectRoot, platform } = opts;
  const { cmd, args } = buildCommand(platform);
  const spawnFn = opts.spawnImpl ?? spawn;
  buffer.push("server", "build", `[devloop] building ${platform}: ${cmd} ${args.join(" ")}`);

  const proc = spawnFn(cmd, args, { cwd: projectRoot });
  let partial = "";
  const onChunk = (chunk: Buffer | string) => {
    partial += chunk.toString();
    const lines = partial.split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) buffer.push("server", "build", line.replace(/\s+$/, ""));
  };
  proc.stdout?.on("data", onChunk);
  proc.stderr?.on("data", onChunk);

  const done = new Promise<{ ok: boolean; code: number | null; fingerprint?: string | null }>((resolve) => {
    proc.on("exit", async (code) => {
      const ok = code === 0;
      buffer.push("server", "build", `[devloop] build ${ok ? "succeeded" : `failed (exit ${code})`}`);
      let fingerprint: string | null | undefined;
      if (ok) {
        fingerprint = await computeFingerprint(projectRoot);
        if (fingerprint) {
          setProjectFingerprint(projectRoot, fingerprint);
          buffer.push("server", "build", `[devloop] recorded native fingerprint ${fingerprint.slice(0, 12)}…`);
        }
      }
      resolve({ ok, code, fingerprint });
    });
    proc.on("error", (err) => {
      buffer.push("server", "build", `[devloop] build error: ${err.message}`);
      resolve({ ok: false, code: null });
    });
  });

  return { done, cancel: () => proc.kill() };
}
