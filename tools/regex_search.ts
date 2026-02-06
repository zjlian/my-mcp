import { globby } from "globby";
import { readFile, stat } from "fs/promises";
import { z } from "zod";
import { isAbsolute, join } from "node:path";
import { requireWorkspace, resolveInWorkspace } from "./workspace.js";

const isBinaryBuffer = (buffer: Uint8Array): boolean => {
  const length = Math.min(buffer.length, 4096);
  for (let i = 0; i < length; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
};

export const regexSearchTool = {
  name: "regex_search",
  options: {
    description: "Search for a pattern in files using globby",
    inputSchema: z.object({
      pattern: z.string().describe("Regex pattern or string to search for"),
      path: z
        .string()
        .describe(
          "File or directory path relative to current workspace. Absolute paths are not allowed.",
        ),
      context_lines: z
        .number()
        .default(0)
        .describe("Number of context lines to show before and after match"),
      ignore_case: z
        .boolean()
        .default(true)
        .describe("Case insensitive search"),
      max_files: z
        .number()
        .default(50)
        .describe("Max number of files to return matches for"),
    }),
  },
  handler: async ({
    pattern,
    path,
    context_lines,
    ignore_case,
    max_files,
  }: {
    pattern: string;
    path: string;
    context_lines: number;
    ignore_case: boolean;
    max_files: number;
  }) => {
    try {
      const rawPath = typeof path === "string" ? path.trim() : "";
      if (!rawPath) {
        return {
          content: [
            {
              type: "text" as const,
              text: "错误：path 参数不能为空",
            },
          ],
          isError: true as const,
        };
      }

      if (isAbsolute(rawPath)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "错误：regex_search 工具不允许使用绝对路径，请先调用 set_workspace 并使用相对当前工作目录的路径",
            },
          ],
          isError: true as const,
        };
      }

      const workspaceBase = (() => {
        try {
          return requireWorkspace();
        } catch (err: any) {
          throw new Error(err?.message ?? String(err));
        }
      })();

      const startTime = Date.now();
      const timeoutMs = 10000;
      let timedOut = false;

      let files: string[] = [];

      const hasGlob =
        rawPath.includes("*") ||
        rawPath.includes("?") ||
        rawPath.includes("[") ||
        rawPath.includes("]");

      if (!hasGlob) {
        try {
          const resolvedPath = resolveInWorkspace(rawPath);
          try {
            const stats = await stat(resolvedPath);

            if (stats.isFile()) {
              files = [resolvedPath];
            } else if (stats.isDirectory()) {
              files = await globby("**/*", {
                cwd: resolvedPath,
                absolute: true,
                onlyFiles: true,
                gitignore: true,
              });
            }
          } catch {
            files = await globby(resolvedPath, {
              absolute: true,
              onlyFiles: true,
              gitignore: true,
            });
          }
        } catch (err: any) {
          return {
            content: [
              {
                type: "text" as const,
                text: err?.message ?? String(err),
              },
            ],
            isError: true as const,
          };
        }
      } else {
        if (rawPath.includes("..")) {
          return {
            content: [
              {
                type: "text" as const,
                text: "错误：路径中不允许包含 .. 以防止越出当前工作目录",
              },
            ],
            isError: true as const,
          };
        }
        const patternAbs = join(workspaceBase, rawPath);
        files = await globby(patternAbs, {
          absolute: true,
          onlyFiles: true,
          gitignore: true,
        });
      }

      const results: string[] = [];
      let filesProcessed = 0;
      const regex = new RegExp(pattern, ignore_case ? "i" : "");

      const maxFileSizeBytes = 5 * 1024 * 1024;
      const concurrency = 8;
      let index = 0;

      const processFile = async (file: string) => {
        if (filesProcessed >= max_files) return;
        if (timedOut) return;
        if (Date.now() - startTime > timeoutMs) {
          timedOut = true;
          return;
        }

        let fileStats;
        try {
          fileStats = await stat(file);
        } catch {
          return;
        }

        if (!fileStats.isFile()) return;
        if (fileStats.size === 0) return;
        if (fileStats.size > maxFileSizeBytes) return;

        const buffer = await readFile(file);
        if (buffer.length === 0) return;
        if (isBinaryBuffer(buffer)) return;
        const content = buffer.toString("utf-8");
        const lines = content.split("\n");
        const matches: string[] = [];
        let firstMatchLine: number | null = null;

        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
          if (Date.now() - startTime > timeoutMs) {
            timedOut = true;
            break;
          }
          const line = lines[lineIndex];
          if (line === undefined) continue;
          if (regex.test(line)) {
            if (firstMatchLine === null) {
              firstMatchLine = lineIndex + 1;
            }
            const start = Math.max(0, lineIndex - context_lines);
            const end = Math.min(lines.length, lineIndex + context_lines + 1);

            for (let i = start; i < end; i++) {
              const prefix = i === lineIndex ? "> " : "  ";
              const lineText = lines[i];
              if (lineText === undefined) continue;
              matches.push(`${prefix}${i + 1}: ${lineText}`);
            }
          }
        }

        if (matches.length > 0) {
          const header =
            firstMatchLine !== null ? `File: ${file}:${firstMatchLine}` : `File: ${file}`;
          results.push(`${header}\n${matches.join("\n")}`);
          filesProcessed++;
        }
      };

      const workers: Promise<void>[] = [];
      const totalFiles = files.length;

      for (let workerIndex = 0; workerIndex < concurrency; workerIndex++) {
        workers.push(
          (async () => {
            while (true) {
              if (filesProcessed >= max_files) break;
              if (timedOut) break;
              const current = index;
              if (current >= totalFiles) break;
              index = current + 1;
              const file = files[current];
              if (!file) {
                console.debug({
                  message: "file missing for current index",
                  current,
                  totalFiles,
                });
                break;
              }
              console.debug({ current, totalFiles, file });
              await processFile(file);
            }
          })(),
        );
      }

      await Promise.all(workers);

      if (results.length === 0) {
        if (timedOut) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No matches found before timeout (10 seconds elapsed).",
              },
            ],
          };
        }
        return {
          content: [{ type: "text" as const, text: "No matches found." }],
        };
      }

      let text = results.join("\n\n");

      if (timedOut) {
        text +=
          "\n\n[Search stopped after 10 seconds timeout; results may be incomplete.]";
      }

      return {
        content: [{ type: "text" as const, text }],
      };
    } catch (error: any) {
      return {
        content: [
          { type: "text" as const, text: `Error: ${error.message}` },
        ],
        isError: true,
      };
    }
  },
};
