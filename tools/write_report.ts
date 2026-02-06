import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { requireWorkspace } from "./workspace.js";

export const writeReportTool = {
  name: "write_report",
  options: {
    description: "在当前工作目录的 .docs 目录创建/覆盖 .md 文件，并返回相对工作目录的路径",
    inputSchema: z.object({
      filename: z
        .string()
        .describe("报告文件名（必须以 .md 结尾），例如 \"daily-report.md\""),
      content: z.string().describe("要写入文件的 Markdown 文本内容"),
    }),
  },
  handler: async ({ filename, content }: { filename: string; content: string }) => {
    try {
      const base = requireWorkspace();

      if (!filename.toLowerCase().endsWith(".md")) {
        return {
          content: [
            {
              type: "text" as const,
              text: "错误：仅允许生成.md后缀的文件",
            },
          ],
          isError: true as const,
        };
      }

      const docsDir = join(base, ".docs");
      const name = basename(filename);
      const target = join(docsDir, name);

      mkdirSync(docsDir, { recursive: true });
      writeFileSync(target, content, { encoding: "utf-8" });

      const relativePath = relative(base, target) || name;

      return {
        content: [
          {
            type: "text" as const,
            text: relativePath,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text" as const,
            text: `错误：写入报告失败 - ${error?.message ?? String(error)}`,
          },
        ],
        isError: true as const,
      };
    }
  },
};
