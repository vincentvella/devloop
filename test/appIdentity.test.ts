import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAndroidPackage, resolveAppScheme, resolveIosBundleId } from "../src/appIdentity.ts";

function proj(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "dl-appid-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

test("iOS bundle id: app.json wins", () => {
  const dir = proj({ "app.json": JSON.stringify({ expo: { ios: { bundleIdentifier: "com.acme.app" } } }) });
  expect(resolveIosBundleId(dir)).toBe("com.acme.app");
  rmSync(dir, { recursive: true, force: true });
});

test("resolveAppScheme: string, first-of-array, and absent", () => {
  const a = proj({ "app.json": JSON.stringify({ expo: { scheme: "caliburr" } }) });
  expect(resolveAppScheme(a)).toBe("caliburr");
  const b = proj({ "app.json": JSON.stringify({ expo: { scheme: ["bonfire", "bonfire2"] } }) });
  expect(resolveAppScheme(b)).toBe("bonfire");
  const c = proj({ "app.json": JSON.stringify({ expo: { ios: { bundleIdentifier: "x" } } }) });
  expect(resolveAppScheme(c)).toBeNull();
  for (const d of [a, b, c]) rmSync(d, { recursive: true, force: true });
});

test("iOS bundle id: literal Info.plist fallback (no app.json id)", () => {
  const dir = proj({
    "app.json": JSON.stringify({ expo: {} }),
    "ios/Caliburr/Info.plist": "<key>CFBundleIdentifier</key>\n<string>com.acme.caliburr</string>",
    "ios/CaliburrTests/Info.plist": "<key>CFBundleIdentifier</key>\n<string>com.acme.caliburr.tests</string>",
  });
  expect(resolveIosBundleId(dir)).toBe("com.acme.caliburr"); // skips the *Tests plist
  rmSync(dir, { recursive: true, force: true });
});

test("iOS bundle id: $(PRODUCT_BUNDLE_IDENTIFIER) resolves from the pbxproj (skips Tests)", () => {
  const dir = proj({
    "ios/App/Info.plist": "<key>CFBundleIdentifier</key>\n<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>",
    "ios/App.xcodeproj/project.pbxproj":
      'PRODUCT_BUNDLE_IDENTIFIER = "com.acme.app.Tests";\nPRODUCT_BUNDLE_IDENTIFIER = com.acme.app;\n',
  });
  expect(resolveIosBundleId(dir)).toBe("com.acme.app");
  rmSync(dir, { recursive: true, force: true });
});

test("iOS bundle id: ignores DERIVE_MACCATALYST_PRODUCT_BUNDLE_IDENTIFIER = NO", () => {
  // Real-world (bonfire): a `DERIVE_MACCATALYST_PRODUCT_BUNDLE_IDENTIFIER = NO;` line
  // preceding the real id would match the unanchored regex → "NO". Must pick the real id.
  const dir = proj({
    "ios/App/Info.plist": "<key>CFBundleIdentifier</key>\n<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>",
    "ios/App.xcodeproj/project.pbxproj":
      "DERIVE_MACCATALYST_PRODUCT_BUNDLE_IDENTIFIER = NO;\nPRODUCT_BUNDLE_IDENTIFIER = com.vincentvella.bonfire;\n",
  });
  expect(resolveIosBundleId(dir)).toBe("com.vincentvella.bonfire");
  rmSync(dir, { recursive: true, force: true });
});

test("Android package: app.json wins, else build.gradle, else manifest", () => {
  const cfg = proj({ "app.json": JSON.stringify({ expo: { android: { package: "com.acme.app" } } }) });
  expect(resolveAndroidPackage(cfg)).toBe("com.acme.app");

  const gradle = proj({ "android/app/build.gradle": 'defaultConfig {\n  applicationId "com.acme.grad"\n}' });
  expect(resolveAndroidPackage(gradle)).toBe("com.acme.grad");

  const manifest = proj({
    "android/app/src/main/AndroidManifest.xml": '<manifest package="com.acme.mani"></manifest>',
  });
  expect(resolveAndroidPackage(manifest)).toBe("com.acme.mani");

  for (const d of [cfg, gradle, manifest]) rmSync(d, { recursive: true, force: true });
});

test("returns null when nothing resolves", () => {
  const dir = proj({ "package.json": "{}" });
  expect(resolveIosBundleId(dir)).toBeNull();
  expect(resolveAndroidPackage(dir)).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});
