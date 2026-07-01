import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectInputsHash } from "../src/expoConfig.ts";

const dir = mkdtempSync(join(tmpdir(), "dl-inputs-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("projectInputsHash is content-based — stable across touches, changes on content change", () => {
  writeFileSync(join(dir, "package.json"), '{"name":"a"}');
  const h1 = projectInputsHash(dir);
  expect(h1).toMatch(/^[0-9a-f]{40}$/);

  // touch (bump mtime, same content) → same hash (the mtime→content-hash fix)
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(dir, "package.json"), later, later);
  expect(projectInputsHash(dir)).toBe(h1);

  // content change → different hash
  writeFileSync(join(dir, "package.json"), '{"name":"b"}');
  const h2 = projectInputsHash(dir);
  expect(h2).not.toBe(h1);

  // adding an app.config.ts is part of the inputs → busts the hash
  writeFileSync(join(dir, "app.config.ts"), "export default { name: 'b' };");
  expect(projectInputsHash(dir)).not.toBe(h2);
});
