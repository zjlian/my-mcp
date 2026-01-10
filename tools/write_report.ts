import { z } from "zod";
import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { basename, join, resolve as resolvePath } from "node:path";

export const writeReportTool = {
  name: "write_report",
  options: {
    description: "在指定工作目录的 .docs 目录创建/覆盖 .md 文件，并返回生成文件的绝对路径",
    inputSchema: z.object({
      workdir: z
        .string()
        .describe("当前工作目录的绝对路径，例如 \"c:\\\\workspace\\\\MCP\""),
      filename: z
        .string()
        .describe("报告文件名（必须以 .md 结尾），例如 \"daily-report.md\""),
      content: z.string().describe("要写入文件的 Markdown 文本内容"),
    }),
  },
  handler: async ({
    workdir,
    filename,
    content,
  }: {
    workdir: string;
    filename: string;
    content: string;
  }) => {
    try {
      const base = resolvePath(workdir);
      if (!existsSync(base) || !statSync(base).isDirectory()) {
        return {
          content: [
            {
              type: "text" as const,
              text: "错误：工作目录不存在或不是目录",
            },
          ],
          isError: true as const,
        };
      }

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

      return {
        content: [
          {
            type: "text" as const,
            text: target,
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

