import { z } from "zod";
import { setWorkspace, getWorkspace } from "./workspace.js";

export const setWorkspaceTool = {
  name: "set_workspace",
  options: {
    description: "设置全局工作目录（绝对路径），供其他工具基于相对路径访问文件",
    inputSchema: z.object({
      workdir: z.string().describe("工作目录的绝对路径"),
    }),
  },
  handler: async ({ workdir }: { workdir: string }) => {
    try {
      setWorkspace(workdir);
      const current = getWorkspace();
      const text = current ? `工作目录已设置为：${current}` : "工作目录已设置";
      return {
        content: [
          {
            type: "text" as const,
            text,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text" as const,
            text: error?.message ?? String(error),
          },
        ],
        isError: true as const,
      };
    }
  },
};

