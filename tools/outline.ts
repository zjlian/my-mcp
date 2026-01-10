import OpenAI from "openai";
import { z } from "zod";
import { createHash } from "node:crypto";
import { mkdir, readFile as readFileFs, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve, isAbsolute, normalize } from "node:path";
import { homedir } from "node:os";

type OutlineCache = {
  get(filePath: string, content: string): Promise<string | null>;
  set(filePath: string, content: string, outline: string): Promise<void>;
};

const CACHE_DIR = join(homedir(), "mcp", "cache");
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function sha256Hex(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function md5Hex(text: string): string {
  return createHash("md5").update(Buffer.from(text, "utf8")).digest("hex");
}

function cachePathForKey(key: string): string {
  return join(CACHE_DIR, `${key}.cache`);
}

async function ensureCacheDir(): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const st = await stat(path);
    return st.isFile();
  } catch {
    return false;
  }
}

async function bestEffortUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
  }
}

async function atomicWriteText(targetPath: string, text: string): Promise<void> {
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(tmpPath, text, "utf8");
    await rename(tmpPath, targetPath);
  } catch (err) {
    await bestEffortUnlink(tmpPath);
    throw err;
  }
}

function isLikelyOutlineCacheFileName(name: string): boolean {
  if (!name.endsWith(".cache")) return false;
  const base = name.slice(0, -".cache".length);
  return /^[0-9a-f]{32}$/.test(base);
}

async function isLikelyOutlineCacheFile(path: string): Promise<boolean> {
  try {
    const content = await readFileFs(path, "utf8");
    const [firstLine, secondLine] = content.split(/\r?\n/);
    const sha = firstLine?.trim() ?? "";
    if (!/^[0-9a-f]{64}$/.test(sha)) return false;
    if ((secondLine ?? "") !== "") return false;
    return true;
  } catch {
    return false;
  }
}

async function cleanupExpiredCacheFiles(): Promise<void> {
  try {
    const entries = await readdir(CACHE_DIR, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!isLikelyOutlineCacheFileName(entry.name)) continue;
      const fullPath = join(CACHE_DIR, entry.name);
      try {
        const st = await stat(fullPath);
        if (now - st.mtime.getTime() > CACHE_TTL_MS) {
          if (await isLikelyOutlineCacheFile(fullPath)) {
            await bestEffortUnlink(fullPath);
          }
        }
      } catch {
      }
    }
  } catch {
  }
}

function createOutlineCache(): OutlineCache {
  return {
    async get(filePath: string, content: string): Promise<string | null> {
      const key = md5Hex(filePath);
      const p = cachePathForKey(key);
      try {
        if (!(await fileExists(p))) return null;
        const cached = await readFileFs(p, "utf8");
        const [firstLine, , ...rest] = cached.split(/\r?\n/);
        const expectedSha = firstLine?.trim();
        if (!expectedSha) return null;
        const actualSha = sha256Hex(content);
        if (expectedSha !== actualSha) return null;
        const out = rest.join("\n").trim();
        return out ? out : null;
      } catch {
        return null;
      }
    },
    async set(filePath: string, content: string, outline: string): Promise<void> {
      const out = outline.trim();
      if (!out) return;
      const key = md5Hex(filePath);
      const p = cachePathForKey(key);
      const payload = `${sha256Hex(content)}\n\n${out}\n`;
      try {
        await ensureCacheDir();
        await atomicWriteText(p, payload);
      } catch {
      }
    },
  };
}

const OUTLINE_SYSTEM_PROMPT = `
You are a precise Code Outline Extractor.
Goal: Produce a compact, structured Markdown outline of the file's *top-level API surface*.

### Hard Rules
1. **Output Format**: Strict Markdown. No code blocks, no intro/outro text.
2. **Scope**: Extract ONLY top-level exported/public definitions. Ignore local variables inside functions.
3. **Detail Level**:
   - For \`Interfaces/Types/Classes\`: You **MUST** list their properties/methods as sub-items.
   - For \`Functions\`: You **MUST** preserve the exact argument types and return types.
4. **Brevity**: Keep summaries to 5 words or less. If in doubt, include a brief summary.
5. Do not overthink. Prefer output over analysis.

### Formatting Template & Example (Follow this strictly!)

**Input Code:**
\`\`\`typescript
interface User {
  id: string; // The user id
  name: string;
}
export function login(user: User): Promise<boolean> { ... }
\`\`\`

**Output:**
## Types
- **Interface**: \`User\`
  - \`id: string\` — The user id
  - \`name: string\`

## Functions
- **Function**: \`login(user: User): Promise<boolean>\`
`;

function guessFenceLanguage(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".ts")) return "typescript";
  if (lower.endsWith(".tsx")) return "tsx";
  if (lower.endsWith(".js")) return "javascript";
  if (lower.endsWith(".jsx")) return "jsx";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".java")) return "java";
  if (lower.endsWith(".kt") || lower.endsWith(".kts")) return "kotlin";
  if (lower.endsWith(".cs")) return "csharp";
  if (lower.endsWith(".c")) return "c";
  if (lower.endsWith(".cc") || lower.endsWith(".cpp") || lower.endsWith(".cxx") || lower.endsWith(".h") || lower.endsWith(".hpp")) return "cpp";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".toml")) return "toml";
  if (lower.endsWith(".md")) return "markdown";
  return "";
}

export const outlineTool = {
  name: "outline",
  options: {
    description: "Generate a structured Markdown outline for a source file.",
    inputSchema: z.object({
      path: z.string().describe("File absolute path"),
    }),
  },
  handler: async ({ path }: { path: string }) => {
    try {
      await cleanupExpiredCacheFiles();

      const rawPath = typeof path === "string" ? path.trim() : "";
      if (!rawPath) {
        return {
          content: [{ type: "text" as const, text: "Error: 'path' is required" }],
          isError: true as const,
        };
      }

      const resolvedPath = isAbsolute(rawPath) ? normalize(rawPath) : resolve(rawPath);

      let st: { isFile(): boolean };
      try {
        st = await stat(resolvedPath);
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: failed to stat '${rawPath}' (resolved: ${resolvedPath}) - ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true as const,
        };
      }

      if (!st.isFile()) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: '${rawPath}' (resolved: ${resolvedPath}) is not a file`,
            },
          ],
          isError: true as const,
        };
      }

      let content: string;
      try {
        content = await readFileFs(resolvedPath, "utf8");
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: failed to read '${rawPath}' (resolved: ${resolvedPath}) - ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true as const,
        };
      }

      if (content.includes("\0")) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: '${rawPath}' appears to be a binary file (NUL byte found)`,
            },
          ],
          isError: true as const,
        };
      }

      const cache = createOutlineCache();
      const cached = await cache.get(resolvedPath, content);
      if (cached) {
        return {
          content: [{ type: "text" as const, text: cached }],
        };
      }

      const apiKey = process.env.MCP_API_KEY?.trim();
      const model = process.env.MCP_MODEL?.trim();
      const baseURL = process.env.MCP_BASE_URL?.trim() || "https://api.openai.com/v1";

      if (!apiKey) {
        return {
          content: [{ type: "text" as const, text: "Error: MCP_API_KEY is not set" }],
          isError: true as const,
        };
      }

      if (!model) {
        return {
          content: [{ type: "text" as const, text: "Error: MCP_MODEL is not set" }],
          isError: true as const,
        };
      }

      const client = new OpenAI({ apiKey, baseURL });

      const fenceLang = guessFenceLanguage(rawPath);
      const userContent = `File: ${rawPath}\n\n\`\`\`${fenceLang}\n${content}\n\`\`\`\n`;

      const response = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: OUTLINE_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        temperature: 0,
      } as any);

      const messageContent = response.choices[0]?.message?.content;
      const outline = typeof messageContent === "string" ? messageContent.trim() : "";

      if (!outline) {
        return {
          content: [{ type: "text" as const, text: "Error: no outline returned by the model" }],
          isError: true as const,
        };
      }

      await cache.set(resolvedPath, content, outline);

      return {
        content: [{ type: "text" as const, text: outline }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: outline tool failed - ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true as const,
      };
    }
  },
};

