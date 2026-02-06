#!/usr/bin/env bun

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { setWorkspaceTool } from "./tools/set_workspace.js";
import { regexSearchTool } from "./tools/regex_search.js";
import { outlineTool } from "./tools/outline.js";
import { writeReportTool } from "./tools/write_report.js";
import { webSearchTool } from "./tools/web_search.js";

const server = new McpServer({
  name: "my-mcp-server",
  version: "0.1.0",
});

server.registerTool(setWorkspaceTool.name, setWorkspaceTool.options, setWorkspaceTool.handler);
server.registerTool(regexSearchTool.name, regexSearchTool.options, regexSearchTool.handler);
server.registerTool(outlineTool.name, outlineTool.options, outlineTool.handler);
server.registerTool(writeReportTool.name, writeReportTool.options, writeReportTool.handler);
server.registerTool(webSearchTool.name, webSearchTool.options, webSearchTool.handler);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
