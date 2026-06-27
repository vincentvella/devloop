/**
 * Shared context for the cockpit self-test (extracted from cockpit/main.ts).
 *
 * The suite drives the REAL, fully-wired main process — same BrowserManager,
 * LogBuffer, tool layer, and renderer window the app uses — so it's a true
 * integration test, not mocks. main.ts assembles this context from its module
 * state and hands it to runSelfTest(); the step files operate through it.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { App, BrowserWindow, Session } from "electron";
import type { LogBuffer } from "../../src/logBuffer.ts";
import type { getPanes } from "../../src/registry.ts";
import type { BrowserManager } from "../browserManager.ts";

export interface SelftestCtx {
  app: App;
  log: (msg: string) => void;
  manager: BrowserManager;
  buffer: LogBuffer;
  handleTool: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
  shellWin: BrowserWindow;
  chosenPort: number;
  getPanes: typeof getPanes;
  /** Build-output base dir (out/) — used to locate the fixture extension. */
  BASE: string;
  /** The panes' shared extension session (persist:devloop-panes). */
  extSession: () => Session;
  /** Load an unpacked extension into every per-project pane session. */
  loadExtIntoAll: (dir: string) => Promise<void>;
  /**
   * Per-step ratchet — call with a step name to (re)start its budget timer; a step
   * that overruns exits the process naming itself. Set up by the orchestrator.
   */
  tick: (name: string) => void;
}

/** A named pass/fail result; the orchestrator prints these and sets the exit code. */
export type Check = [name: string, ok: boolean];
