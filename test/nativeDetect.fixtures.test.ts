import { expect, test } from "bun:test";
import { join } from "node:path";
import { readAppJsonPlatforms, resolvedExpoPlatforms } from "../src/expoConfig.ts";
import { webTargetForProject } from "../src/nativeBuild.ts";

// Opt-in end-to-end: these drive the REAL `expo config` against installed sample apps,
// so they need `bun install` in test/fixtures/expo first (see its README). CI skips
// them — the pure matrix in nativeBuild.test.ts is the gate. Run:
//   cd test/fixtures/expo && bun install
//   RUN_EXPO_FIXTURES=1 bun test nativeDetect.fixtures
const FIXTURES = join(import.meta.dir, "fixtures/expo");
const it = process.env.RUN_EXPO_FIXTURES === "1" ? test : test.skip;

/** Mirror the cockpit's nativeInfo web decision for a project dir (the real path). */
async function webTarget(dir: string): Promise<boolean> {
  const pkg = await Bun.file(join(dir, "package.json")).json();
  const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };
  const expoConfigPlatforms = deps.expo ? await resolvedExpoPlatforms(dir) : null;
  return webTargetForProject({ expoConfigPlatforms, appJsonPlatforms: readAppJsonPlatforms(dir), deps });
}

it("web-inferred (app.config.ts, no platforms, react-native-web installed) → Web target", async () => {
  expect(await webTarget(join(FIXTURES, "web-inferred"))).toBe(true);
});

it("web-excluded (app.config.ts platforms omit web) → no Web target", async () => {
  expect(await webTarget(join(FIXTURES, "web-excluded"))).toBe(false);
});

it("web-explicit (app.json platforms include web) → Web target", async () => {
  expect(await webTarget(join(FIXTURES, "web-explicit"))).toBe(true);
});

it("bare-rn (react-native, no expo, no react-native-web) → no Web target", async () => {
  expect(await webTarget(join(FIXTURES, "bare-rn"))).toBe(false);
});
