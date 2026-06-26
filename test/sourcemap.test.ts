import { expect, test } from "bun:test";
import { addMapping, GenMapping, toEncodedMap } from "@jridgewell/gen-mapping";
import { createResolver, parseStackFrames, resolveStackString } from "../src/sourcemap.ts";

test("parseStackFrames handles named and anonymous frames", () => {
  const stack = `Error: boom
    at boom (http://h/app.js:10:15)
    at http://h/app.js:20:3
    at <anonymous>:1:1`;
  const frames = parseStackFrames(stack);
  expect(frames.length).toBe(3);
  expect(frames[0]).toEqual({ fn: "boom", url: "http://h/app.js", line: 10, column: 15 });
  expect(frames[1]).toEqual({ url: "http://h/app.js", line: 20, column: 3 });
  expect(frames[2]).toEqual({ url: "<anonymous>", line: 1, column: 1 }); // parsed but the resolver skips non-http urls
});

// Build a real (inline) source map with gen-mapping, serve it via a stub fetch, and resolve.
function jsWithInlineMap(): string {
  const gen = new GenMapping({ file: "app.js" });
  // generated (line 1, col 10) maps to original src/app.ts (line 5, col 2), name "boom"
  addMapping(gen, {
    generated: { line: 1, column: 10 },
    source: "src/app.ts",
    original: { line: 5, column: 2 },
    name: "boom",
  });
  const map = JSON.stringify(toEncodedMap(gen));
  const b64 = Buffer.from(map, "utf8").toString("base64");
  return `console.log(1);\n//# sourceMappingURL=data:application/json;base64,${b64}`;
}

test("createResolver maps a compiled position to original source via the inline map", async () => {
  const code = jsWithInlineMap();
  const fetchImpl = (async () => new Response(code, { status: 200 })) as unknown as typeof fetch;
  const resolver = createResolver(fetchImpl);
  const pos = await resolver.resolve("http://h/app.js", 1, 10);
  expect(pos).not.toBeNull();
  expect(pos!.source).toBe("src/app.ts");
  expect(pos!.line).toBe(5);
  expect(pos!.name).toBe("boom");
  expect(await resolver.resolve("chrome://x", 1, 1)).toBeNull(); // non-fetchable scheme
});

test("resolveStackString maps frames and leaves unmappable ones raw", async () => {
  const code = jsWithInlineMap();
  const fetchImpl = (async () => new Response(code, { status: 200 })) as unknown as typeof fetch;
  const out = await resolveStackString(`Error: x\n    at boom (http://h/app.js:1:10)`, createResolver(fetchImpl));
  expect(out).not.toBeNull();
  expect(out!.frames[0]!.source).toBe("src/app.ts");
  expect(out!.pretty).toContain("src/app.ts:5");
});

test("resolveStackString returns null when nothing maps", async () => {
  const fetchImpl = (async () => new Response("no map here", { status: 200 })) as unknown as typeof fetch;
  expect(await resolveStackString(`Error: x\n    at f (http://h/x.js:1:1)`, createResolver(fetchImpl))).toBeNull();
});
