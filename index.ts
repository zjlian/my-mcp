import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { regexSearchTool } from "./tools/regex_search.js";
import { outlineTool } from "./tools/outline.js";

const server = new McpServer({
  name: "my-mcp-server",
  version: "0.1.0",
});

server.registerTool(regexSearchTool.name, regexSearchTool.options, regexSearchTool.handler);
server.registerTool(outlineTool.name, outlineTool.options, outlineTool.handler);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
