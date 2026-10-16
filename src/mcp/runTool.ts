import { record } from "../log/activity";
import { S2Client } from "../s2/client";
import { newStats } from "../s2/types";
import { ToolError, errorMessage } from "./errors";
import { prepareArgs } from "./schema";
import { ToolDef } from "./tools";

export type ToolOutcome =
  { ok: true; value: unknown } | { ok: false; message: string };

/** Validates args, runs the tool, records it in the activity log. Never throws. */
export async function runTool(
  tool: ToolDef,
  rawArgs: unknown,
  s2: S2Client,
  via: "mcp" | "rest",
): Promise<ToolOutcome> {
  const stats = newStats();
  const start = Date.now();
  let outcome: ToolOutcome;
  try {
    const args = prepareArgs(tool.inputSchema, rawArgs);
    outcome = { ok: true, value: await tool.handler(args, { s2, stats }) };
  } catch (e) {
    if (!(e instanceof ToolError)) Zotero.logError(e as Error);
    outcome = { ok: false, message: errorMessage(e) };
  }
  record({
    time: start,
    via,
    tool: tool.name,
    args: rawArgs,
    durationMs: Date.now() - start,
    s2Calls: stats.s2Calls,
    retries: stats.retries,
    ok: outcome.ok,
    error: outcome.ok ? undefined : outcome.message,
  });
  return outcome;
}
