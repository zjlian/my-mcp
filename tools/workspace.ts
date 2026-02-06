import { statSync } from "node:fs";
import { isAbsolute, normalize, resolve, relative } from "node:path";

let currentWorkspace: string | null = null;

export function setWorkspace(workdir: string): void {
  const raw = typeof workdir === "string" ? workdir.trim() : "";
  if (!raw) {
    throw new Error("错误：工作目录路径不能为空");
  }
  if (!isAbsolute(raw)) {
    throw new Error("错误：set_workspace 需要绝对路径工作目录");
  }

  const normalized = normalize(resolve(raw));

  let st;
  try {
    st = statSync(normalized);
  } catch {
    throw new Error("错误：工作目录不存在或不是目录");
  }

  if (!st.isDirectory()) {
    throw new Error("错误：工作目录不存在或不是目录");
  }

  currentWorkspace = normalized;
}

export function getWorkspace(): string | null {
  return currentWorkspace;
}

export function requireWorkspace(): string {
  if (!currentWorkspace) {
    throw new Error("错误：请先调用 set_workspace 设置工作目录");
  }
  return currentWorkspace;
}

export function ensureInsideWorkspace(resolvedPath: string): void {
  const base = requireWorkspace();
  const rel = relative(base, resolvedPath);
  if (!rel || rel === "") return;
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("错误：路径不允许越出当前工作目录");
  }
}

export function resolveInWorkspace(relPath: string): string {
  const base = requireWorkspace();
  const raw = typeof relPath === "string" ? relPath.trim() : "";
  if (!raw) {
    throw new Error("错误：路径不能为空");
  }
  if (isAbsolute(raw)) {
    throw new Error(
      "错误：不允许在工具中使用绝对路径，请使用相对当前工作目录的路径",
    );
  }
  if (raw.includes("..")) {
    throw new Error("错误：路径中不允许包含 .. 以防止越出工作目录");
  }
  const resolvedPath = normalize(resolve(base, raw));
  ensureInsideWorkspace(resolvedPath);
  return resolvedPath;
}

