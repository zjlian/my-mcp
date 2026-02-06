import OpenAI from "openai";
import { z } from "zod";

const BASE_URL = "https://api.unifuncs.com/deepsearch/v1";
const DEFAULT_MODEL = "s2";

function normalizeMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) {
        const text = (part as any).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .join("");
  return parts;
}

export const webSearchTool = {
  name: "web_search",
  options: {
    description: "联网搜索最新信息",
    inputSchema: z.object({
      query: z.string().describe("搜索关键词/问题"),
    }),
  },
  handler: async ({ query }: { query: string }) => {
    try {
      const rawQuery = typeof query === "string" ? query.trim() : "";
      if (!rawQuery) {
        return {
          content: [{ type: "text" as const, text: "错误：query 参数不能为空" }],
          isError: true as const,
        };
      }

      const apiKey = process.env.MCP_WEB_SEARCH_API_KEY?.trim();
      if (!apiKey) {
        return {
          content: [
            { type: "text" as const, text: "Error: MCP_WEB_SEARCH_API_KEY is not set" },
          ],
          isError: true as const,
        };
      }

      const model = process.env.MCP_WEB_SEARCH_MODEL?.trim() || DEFAULT_MODEL;
      const client = new OpenAI({ apiKey, baseURL: BASE_URL });
      const response = await client.chat.completions.create({
        model,
        messages: [{ role: "user", content: rawQuery }],
        stream: false,
      } as any);

      const messageContent = response.choices[0]?.message?.content;
      const text = normalizeMessageContent(messageContent).trim();

      if (!text) {
        return {
          content: [{ type: "text" as const, text: "Error: empty response" }],
          isError: true as const,
        };
      }

      return {
        content: [{ type: "text" as const, text }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: web_search tool failed - ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true as const,
      };
    }
  },
};
