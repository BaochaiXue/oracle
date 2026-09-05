import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OracleClient } from "../../../packages/oracle-client/src/index.js";
import { resolveBrokerPaths, type BrokerPaths } from "../../v2/broker.js";

type JobToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
};

const jobIdShape = {
  jobId: z.string().trim().min(1).describe("Durable Oracle v2 job id."),
};

const jobStatusOutputShape = {
  jobId: z.string(),
  state: z.string(),
  stateVersion: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
};

const jobResultOutputShape = {
  jobId: z.string(),
  state: z.string(),
  ready: z.boolean(),
  output: z.string(),
};

const jobEventsOutputShape = {
  jobId: z.string(),
  events: z.array(
    z.object({
      seq: z.number().int().nonnegative(),
      type: z.string(),
      createdAt: z.string(),
    }),
  ),
};

async function withJobClient(
  paths: BrokerPaths | undefined,
  run: (client: OracleClient) => Promise<JobToolResult>,
): Promise<JobToolResult> {
  const client = new OracleClient({ socketPath: (paths ?? resolveBrokerPaths()).socketPath });
  try {
    return await run(client);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { isError: true, content: [{ type: "text", text: message }] };
  } finally {
    client.close();
  }
}

export function runJobStatusTool(input: unknown, paths?: BrokerPaths): Promise<JobToolResult> {
  const parsed = z.object(jobIdShape).strict().parse(input);
  return withJobClient(paths, async (client) => {
    const job = await client.getJob(parsed.jobId);
    const output = `Oracle v2 job ${job.id}: ${job.state.kind}`;
    return {
      content: [{ type: "text", text: output }],
      structuredContent: {
        jobId: job.id,
        state: job.state.kind,
        stateVersion: job.stateVersion,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      },
    };
  });
}

export function runJobResultTool(input: unknown, paths?: BrokerPaths): Promise<JobToolResult> {
  const parsed = z.object(jobIdShape).strict().parse(input);
  return withJobClient(paths, async (client) => {
    const result = await client.getResult(parsed.jobId);
    const output = result.ready
      ? result.text
      : `Oracle v2 job ${result.jobId} is ${result.state}; result not ready.`;
    return {
      content: [{ type: "text", text: output }],
      structuredContent: {
        jobId: result.jobId,
        state: result.state,
        ready: result.ready,
        output: result.ready ? result.text : "",
      },
    };
  });
}

export function runJobEventsTool(input: unknown, paths?: BrokerPaths): Promise<JobToolResult> {
  const parsed = z
    .object({ ...jobIdShape, after: z.number().int().nonnegative().optional() })
    .strict()
    .parse(input);
  return withJobClient(paths, async (client) => {
    const events = await client.listEvents(parsed.jobId, { after: parsed.after });
    const output = events.length
      ? events.map((event) => `${event.seq}\t${event.type}\t${event.createdAt}`).join("\n")
      : "No newer Oracle v2 job events.";
    return {
      content: [{ type: "text", text: output }],
      structuredContent: {
        jobId: parsed.jobId,
        events: events.map(({ seq, type, createdAt }) => ({ seq, type, createdAt })),
      },
    };
  });
}

export function runJobResumeTool(input: unknown, paths?: BrokerPaths): Promise<JobToolResult> {
  const parsed = z.object(jobIdShape).strict().parse(input);
  return withJobClient(paths, async (client) => {
    const job = await client.resumeJob(parsed.jobId);
    const output = `Resume accepted for Oracle v2 job ${job.id}; state ${job.state.kind}.`;
    return {
      content: [{ type: "text", text: output }],
      structuredContent: {
        jobId: job.id,
        state: job.state.kind,
        stateVersion: job.stateVersion,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      },
    };
  });
}

export function registerJobTools(server: McpServer): void {
  server.registerTool(
    "job_status",
    {
      title: "Inspect an Oracle v2 job",
      description: "Read the current durable state and metadata for one Oracle v2 job.",
      inputSchema: jobIdShape,
      outputSchema: jobStatusOutputShape,
    },
    (input: unknown) => runJobStatusTool(input),
  );
  server.registerTool(
    "job_result",
    {
      title: "Read an Oracle v2 job result",
      description: "Read the final answer when ready, or the current non-terminal state.",
      inputSchema: jobIdShape,
      outputSchema: jobResultOutputShape,
    },
    (input: unknown) => runJobResultTool(input),
  );
  server.registerTool(
    "job_events",
    {
      title: "Read Oracle v2 job events",
      description: "Read the sequenced durable event stream, optionally after a known cursor.",
      inputSchema: { ...jobIdShape, after: z.number().int().nonnegative().optional() },
      outputSchema: jobEventsOutputShape,
    },
    (input: unknown) => runJobEventsTool(input),
  );
  server.registerTool(
    "job_resume",
    {
      title: "Resume an Oracle v2 job",
      description:
        "Explicitly resume an eligible ordinary job. Batch-owned jobs remain under their parent authority.",
      inputSchema: jobIdShape,
      outputSchema: jobStatusOutputShape,
    },
    (input: unknown) => runJobResumeTool(input),
  );
}
