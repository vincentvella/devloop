# Expo target-detection fixtures (opt-in)

Real sample Expo apps for the end-to-end detection test (`test/nativeDetect.fixtures.test.ts`),
which drives the actual `expo config` path (`src/expoConfig.ts`) against each shape.

**CI does not run these** — the fast pure matrix in `test/nativeBuild.test.ts` is the gate.
These need Expo installed, so they're gated behind `RUN_EXPO_FIXTURES=1`.

## Run

```sh
cd test/fixtures/expo && bun install           # installs Expo into the web-* fixtures (workspace)
cd ../../.. && RUN_EXPO_FIXTURES=1 bun test nativeDetect.fixtures
```

## Shapes

| fixture        | config                                              | expected  |
| -------------- | --------------------------------------------------- | --------- |
| `web-inferred` | `app.config.ts`, no `platforms`, react-native-web installed | **Web** (Expo infers it) |
| `web-excluded` | `app.config.ts` `platforms: ["ios","android"]`      | no Web (the **bonfire** shape) |
| `web-explicit` | `app.json` `platforms: ["ios","android","web"]`     | **Web** (caliburr-ish) |
| `bare-rn`      | `react-native`, no expo / no react-native-web       | no Web (needs no install) |

`node_modules/` here is gitignored; the fixtures are checked in as source only.
