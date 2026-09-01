import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fixturePage } from "./page.js";
import { FIXTURE_SCENARIOS, type FixtureScenario, type FixtureTurn } from "./types.js";

export class OracleProviderFixture {
  private readonly turns = new Map<string, FixtureTurn>();
  private readonly sends = new Map<string, number>();
  private server?: http.Server;
  private origin?: string;

  async start(): Promise<void> {
    if (this.server) throw new Error("Oracle provider fixture is already started");
    const server = http.createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    this.server = server;
    this.origin = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close((error) => (error ? reject(error) : resolve()));
    });
    this.server = undefined;
    this.origin = undefined;
  }

  urlFor(jobId: string, scenario: FixtureScenario = "default"): string {
    return `${this.requireOrigin()}/?job=${encodeURIComponent(jobId)}&scenario=${scenario}`;
  }

  sendCount(turnAttemptId: string): number {
    return this.sends.get(turnAttemptId) ?? 0;
  }

  totalSendCount(): number {
    return [...this.sends.values()].reduce((sum, value) => sum + value, 0);
  }

  turn(jobId: string): FixtureTurn | undefined {
    return this.turns.get(jobId);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const origin = this.requireOrigin();
      const url = new URL(request.url ?? "/", origin);
      if (request.method === "POST" && url.pathname === "/api/send") {
        const input = JSON.parse((await readBody(request)).toString("utf8")) as Record<
          string,
          unknown
        >;
        const jobId = requiredString(input.jobId, "jobId");
        const turnAttemptId = requiredString(input.turnAttemptId, "turnAttemptId");
        const scenario = parseScenario(input.scenario);
        const sendCount = (this.sends.get(turnAttemptId) ?? 0) + 1;
        this.sends.set(turnAttemptId, sendCount);
        if (scenario === "commit-delay") await delay(80);
        const conversationId = `fixture-${jobId.replaceAll("_", "-")}`;
        const turn: FixtureTurn = {
          jobId,
          turnAttemptId,
          prompt: requiredString(input.prompt, "prompt"),
          ...(typeof input.bundleSha256 === "string" ? { bundleSha256: input.bundleSha256 } : {}),
          ...(typeof input.bundleFilename === "string"
            ? { bundleFilename: input.bundleFilename }
            : {}),
          conversationId,
          conversationUrl: `/c/${encodeURIComponent(conversationId)}`,
          assistantMarkdown: `# Fixture answer\n\nCompleted ${jobId}.\n`,
          assistantHtml: `<h1>Fixture answer</h1><p>Completed ${escapeHtml(jobId)}.</p>`,
          sendCount,
          scenario,
          committed: scenario !== "click-dropped",
        };
        this.turns.set(jobId, turn);
        sendJson(response, 200, turn);
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/c/")) {
        const conversationId = decodeURIComponent(url.pathname.slice(3));
        const turn = [...this.turns.values()].find(
          (candidate) => candidate.conversationId === conversationId,
        );
        if (!turn) {
          sendJson(response, 404, { error: "unknown_conversation" });
          return;
        }
        sendHtml(response, fixturePage({ jobId: turn.jobId, scenario: turn.scenario, turn }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/") {
        const jobId = url.searchParams.get("job") ?? "probe";
        const scenario = parseScenario(url.searchParams.get("scenario") ?? "default");
        sendHtml(response, fixturePage({ jobId, scenario, turn: this.turns.get(jobId) }));
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      sendJson(response, 400, {
        error: "fixture_error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private requireOrigin(): string {
    if (!this.origin) throw new Error("Oracle provider fixture is not started");
    return this.origin;
  }
}

function parseScenario(value: unknown): FixtureScenario {
  if (typeof value === "string" && FIXTURE_SCENARIOS.includes(value as FixtureScenario)) {
    return value as FixtureScenario;
  }
  throw new Error(`Unknown fixture scenario: ${String(value)}`);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendHtml(response: ServerResponse, body: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
