import { globby } from "globby";
import { readFile, stat } from "fs/promises";
import { z } from "zod";

export const regexSearchTool = {
  name: "regex_search",
  options: {
    description: "Search for a pattern in files using globby",
    inputSchema: z.object({
      pattern: z.string().describe("Regex pattern or string to search for"),
      path: z.string().describe("File or directory absolute path to search in"),
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
      const startTime = Date.now();
      const timeoutMs = 10000;
      let timedOut = false;

      let files: string[] = [];

      try {
        const stats = await stat(path);

        if (stats.isFile()) {
          files = [path];
        } else if (stats.isDirectory()) {
          files = await globby("**/*", {
            cwd: path,
            absolute: true,
            onlyFiles: true,
          });
        }
      } catch {
        files = await globby(path, {
          absolute: true,
          onlyFiles: true,
        });
      }

      const results: string[] = [];
      let filesProcessed = 0;
      const regex = new RegExp(pattern, ignore_case ? "i" : "");

      for (const file of files) {
        if (filesProcessed >= max_files) break;
        if (Date.now() - startTime > timeoutMs) {
          timedOut = true;
          break;
        }

        const content = await readFile(file, "utf-8");
        const lines = content.split("\n");
        const matches: string[] = [];
        let firstMatchLine: number | null = null;

        for (let index = 0; index < lines.length; index++) {
          if (Date.now() - startTime > timeoutMs) {
            timedOut = true;
            break;
          }
          const line = lines[index];
          if (line === undefined) {
            continue;
          }
          if (regex.test(line)) {
            if (firstMatchLine === null) {
              firstMatchLine = index + 1;
            }
            const start = Math.max(0, index - context_lines);
            const end = Math.min(lines.length, index + context_lines + 1);

            for (let i = start; i < end; i++) {
              const prefix = i === index ? "> " : "  ";
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
      }

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

