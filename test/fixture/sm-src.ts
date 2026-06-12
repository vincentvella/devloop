// Original source for the source-map test. Bundled+minified+source-mapped by the
// fixture server; throwing here should resolve back to "sm-src.ts" via the map.
function boomFromSource(): void {
  throw new Error("mapped-from-source");
}

boomFromSource();
