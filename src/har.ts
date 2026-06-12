/**
 * Network detail stored on `browser:network` log entries, and a HAR 1.2 builder.
 * Which requests are captured is governed by DEVLOOP_NET_THRESHOLD (failures are
 * always logged; set the threshold to 0 to capture every response for a full HAR).
 */
import type { LogEntry } from "./logBuffer.ts";

export interface NetDetail {
  kind: "network";
  url: string;
  method?: string;
  status?: number;
  statusText?: string;
  resourceType?: string;
  mimeType?: string;
  startedAt?: number; // epoch ms
  durationMs?: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  failure?: string;
}

const pairs = (h?: Record<string, string>) => Object.entries(h ?? {}).map(([name, value]) => ({ name, value: String(value) }));

/** Build a HAR 1.2 object from the network entries in a set of log entries. */
export function toHar(entries: LogEntry[]): unknown {
  const net = entries.filter((e) => e.source === "browser" && e.stream === "network" && e.detail) as (LogEntry & { detail: NetDetail })[];
  return {
    log: {
      version: "1.2",
      creator: { name: "devloop", version: "0.1" },
      entries: net.map((e) => {
        const d = e.detail;
        const reqBody = d.requestBody;
        const resBody = d.responseBody ?? "";
        return {
          startedDateTime: new Date(d.startedAt ?? e.ts).toISOString(),
          time: d.durationMs ?? 0,
          request: {
            method: d.method ?? "GET",
            url: d.url,
            httpVersion: "HTTP/1.1",
            cookies: [],
            headers: pairs(d.requestHeaders),
            queryString: [],
            headersSize: -1,
            bodySize: reqBody ? reqBody.length : 0,
            ...(reqBody ? { postData: { mimeType: d.requestHeaders?.["content-type"] ?? "application/octet-stream", text: reqBody } } : {}),
          },
          response: {
            status: d.status ?? 0,
            statusText: d.statusText ?? (d.failure ? "Failed" : ""),
            httpVersion: "HTTP/1.1",
            cookies: [],
            headers: pairs(d.responseHeaders),
            content: { size: resBody.length, mimeType: d.mimeType ?? "", text: resBody },
            redirectURL: "",
            headersSize: -1,
            bodySize: resBody.length,
          },
          cache: {},
          timings: { send: 0, wait: d.durationMs ?? 0, receive: 0 },
          ...(d.failure ? { _failure: d.failure } : {}),
        };
      }),
    },
  };
}
