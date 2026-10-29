import { getS2Client } from "../http/endpoints";
import { runTool, ToolOutcome } from "../mcp/runTool";
import { TOOLS_BY_NAME } from "../mcp/tools";
import { S2Client } from "../s2/client";

/**
 * Test seam: integration tests swap `s2` for a fixture client. The GUI has
 * no client of its own, so production traffic shares the endpoints' limiter.
 */
export const guiDeps: { s2: () => S2Client } = {
  s2: () => getS2Client(),
};

/** Every S2 call and library write from the GUI goes through a tool. */
export function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) throw new Error(`Unknown tool ${name}`);
  return runTool(tool, args, guiDeps.s2(), "gui");
}
