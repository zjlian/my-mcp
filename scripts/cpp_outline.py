#!/usr/bin/env python3
import sys
import os
import argparse
import json
import re
import shlex
import clang.cindex
from clang.cindex import CursorKind

INCLUDE_DIR_NAMES = ("include", "inc", "Include", "Includes")
PROJECT_ROOT_MARKERS = (".git", "compile_commands.json", "CMakeLists.txt", "meson.build", "BUILD", "WORKSPACE")
COMPILE_COMMANDS_SEARCH_MAX_PARENT_LEVELS = 40
INCLUDE_INFER_MAX_PARENT_LEVELS = 8
CURSOR_TOKEN_LOOKAHEAD_LIMIT = 96
MISSING_HEADERS_PER_FILE_LIMIT = 6
HEADER_SEARCH_MAX_PARENT_LEVELS = 20
HEADER_SEARCH_VENDOR_DIR_NAMES = ("thirdparty", "third_party", "3rdparty", "3rd_party", "deps", "external", "vendor")
HEADER_SEARCH_MAX_DEPTH = 12
HEADER_SEARCH_MAX_DIRS = 6000

TARGET_KINDS = {
    CursorKind.NAMESPACE: "Namespace",
    CursorKind.CLASS_DECL: "Class",
    CursorKind.STRUCT_DECL: "Struct",
    CursorKind.CLASS_TEMPLATE: "Class Template",
    CursorKind.CXX_METHOD: "Method",
    CursorKind.FUNCTION_DECL: "Function",
    CursorKind.FUNCTION_TEMPLATE: "Function Template",
    CursorKind.CONSTRUCTOR: "Constructor",
    CursorKind.DESTRUCTOR: "Destructor",
    CursorKind.ENUM_DECL: "Enum",
    CursorKind.FIELD_DECL: "Field",
}

def format_tokens(tokens):
    """
    将离散的 Token 单词重新拼接成符合人类阅读习惯的 C++ 语法字符串
    """
    raw = " ".join(tokens)
    
    # 用一些简单的替换规则让空格看起来正常
    replacements = [
        (" :: ", "::"), (" ::", "::"), (":: ", "::"),
        (" (", "("), ("( ", "("),
        (" )", ")"),
        (" ,", ","), (" , ", ", "), (",  ", ", "),
        (" < ", "<"), (" <", "<"), ("< ", "<"),
        (" >", ">"),
        (" & ", "& "), (" &", "&"),
        (" * ", "* "), (" *", "*"),
        ("~ ", "~")
    ]
    
    for old, new in replacements:
        raw = raw.replace(old, new)
        
    return raw.strip()

def get_raw_signature(cursor):
    """
    核心黑科技：绕过语义分析(AST)，直接提取源代码里的物理文本 Token
    """
    # 如果不是函数或字段，退回旧的简单名称
    if cursor.kind not in (CursorKind.CXX_METHOD, CursorKind.FUNCTION_DECL, 
                           CursorKind.FUNCTION_TEMPLATE, CursorKind.CONSTRUCTOR, 
                           CursorKind.DESTRUCTOR, CursorKind.FIELD_DECL):
        return cursor.displayname or cursor.spelling

    tokens = []
    param_depth = 0
    
    for t in cursor.get_tokens():
        if t.kind == clang.cindex.TokenKind.COMMENT:
            continue
        s = t.spelling
        
        # 记录小括号深度，以免被参数里的复杂符号干扰
        if s == '(': 
            param_depth += 1
        elif s == ')': 
            param_depth -= 1
            
        # 停止提取的条件 1：遇到函数体开始 '{' 或者声明结束的 ';'
        if (s == '{' or s == ';') and param_depth == 0:
            break
            
        # 停止提取的条件 2：对于构造函数，剥离后面的初始化列表（遇到不在参数内的 ':'）
        # 让 DataSource(SessionPool&) : IData() 变成干净的 DataSource(SessionPool&)
        if s == ':' and param_depth == 0 and cursor.kind == CursorKind.CONSTRUCTOR:
            break
            
        tokens.append(s)

    return format_tokens(tokens)

def cursor_in_target_file(cursor, target_filepath):
    return cursor_in_target_file_with_kind(cursor, target_filepath, None)

def safe_cursor_kind(cursor):
    try:
        return cursor.kind
    except Exception:
        return None

def cursor_in_target_file_with_kind(cursor, target_filepath, cursor_kind):
    try:
        if cursor.location.file and os.path.abspath(cursor.location.file.name) == target_filepath:
            return True
    except Exception:
        pass
    try:
        if cursor.extent and cursor.extent.start.file and os.path.abspath(cursor.extent.start.file.name) == target_filepath:
            return True
    except Exception:
        pass
    try:
        if cursor.extent and cursor.extent.end.file and os.path.abspath(cursor.extent.end.file.name) == target_filepath:
            return True
    except Exception:
        pass

    if cursor_kind in TARGET_KINDS:
        try:
            for i, t in enumerate(cursor.get_tokens()):
                if i >= CURSOR_TOKEN_LOOKAHEAD_LIMIT:
                    break
                if t.location.file and os.path.abspath(t.location.file.name) == target_filepath:
                    return True
        except Exception:
            pass

    return False

def cursor_start_line_in_target(cursor, target_filepath):
    try:
        if cursor.extent and cursor.extent.start.file and os.path.abspath(cursor.extent.start.file.name) == target_filepath:
            return cursor.extent.start.line
    except Exception:
        pass
    try:
        for i, t in enumerate(cursor.get_tokens()):
            if i >= CURSOR_TOKEN_LOOKAHEAD_LIMIT:
                break
            if t.location.file and os.path.abspath(t.location.file.name) == target_filepath:
                return t.location.line
    except Exception:
        pass
    return cursor.location.line

def should_print_cursor(cursor, target_filepath):
    if cursor.kind == CursorKind.FUNCTION_DECL and not cursor.is_definition():
        try:
            definition = cursor.get_definition()
            definition_kind = safe_cursor_kind(definition) if definition else None
            if definition and cursor_in_target_file_with_kind(definition, target_filepath, definition_kind):
                return False
        except Exception:
            pass
    return cursor.is_definition() or cursor.kind in (CursorKind.CXX_METHOD, CursorKind.CONSTRUCTOR, CursorKind.DESTRUCTOR)

def walk_ast(cursor, target_filepath, current_depth=0):
    cursor_kind = safe_cursor_kind(cursor)
    if cursor_kind is None:
        return
    if cursor_kind != CursorKind.TRANSLATION_UNIT and not cursor_in_target_file_with_kind(cursor, target_filepath, cursor_kind):
        return

    printed = False
    if cursor_kind in TARGET_KINDS and cursor.spelling:
        kind_label = TARGET_KINDS[cursor_kind]
        # 👇 这里替换为我们新写的 Token 原文提取函数
        signature = get_raw_signature(cursor)
        line_num = cursor_start_line_in_target(cursor, target_filepath)
        
        if should_print_cursor(cursor, target_filepath):
            indent = "  " * current_depth
            print(f"{indent}- [Line {line_num}] **{kind_label}** `{signature}`")
            printed = True

    next_depth = current_depth + 1 if printed else current_depth
    for child in cursor.get_children():
        walk_ast(child, target_filepath, next_depth)

def configure_libclang_from_env():
    lib_file = os.environ.get("LIBCLANG_FILE")
    lib_path = os.environ.get("LIBCLANG_PATH")
    try:
        if lib_file:
            clang.cindex.Config.set_library_file(lib_file)
        elif lib_path:
            clang.cindex.Config.set_library_path(lib_path)
    except Exception:
        return

def infer_include_dirs(abs_filepath):
    file_dir = os.path.dirname(abs_filepath)
    candidates = []

    def add_dir(p):
        if not p:
            return
        p = os.path.abspath(p)
        if p in seen:
            return
        if os.path.isdir(p):
            seen.add(p)
            candidates.append(p)

    seen = set()
    add_dir(file_dir)

    cur = file_dir
    for _ in range(INCLUDE_INFER_MAX_PARENT_LEVELS):
        for name in INCLUDE_DIR_NAMES:
            add_dir(os.path.join(cur, name))

        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent

    return candidates

def find_project_root(start_dir):
    cur = os.path.abspath(start_dir)
    for _ in range(COMPILE_COMMANDS_SEARCH_MAX_PARENT_LEVELS):
        for m in PROJECT_ROOT_MARKERS:
            if os.path.exists(os.path.join(cur, m)):
                return cur
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    return os.path.abspath(start_dir)

def find_header_search_base(start_dir):
    cur = os.path.abspath(start_dir)
    fallback = None
    for _ in range(HEADER_SEARCH_MAX_PARENT_LEVELS):
        for n in HEADER_SEARCH_VENDOR_DIR_NAMES:
            if os.path.isdir(os.path.join(cur, n)):
                return cur
        for m in PROJECT_ROOT_MARKERS:
            if fallback is None and os.path.exists(os.path.join(cur, m)):
                fallback = cur
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    return fallback or os.path.abspath(start_dir)

def extract_missing_headers(diagnostics):
    out = []
    for d in diagnostics:
        try:
            spelling = d.spelling or ""
        except Exception:
            continue
        m = re.search(r"'([^']+)' file not found", spelling)
        if not m:
            continue
        header = m.group(1)
        if header and header not in out:
            out.append(header)
    return out

def find_header_dir(header_name, search_roots, max_depth=HEADER_SEARCH_MAX_DEPTH, max_dirs=HEADER_SEARCH_MAX_DIRS):
    seen_dirs = 0
    for root in search_roots:
        root = os.path.abspath(root)
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            rel = os.path.relpath(dirpath, root)
            depth = 0 if rel == "." else rel.count(os.sep) + 1
            if depth > max_depth:
                dirnames[:] = []
                continue
            seen_dirs += 1
            if seen_dirs > max_dirs:
                return None
            if header_name in filenames:
                return dirpath
    return None

def try_auto_add_missing_header_includes(abs_filepath, configured_args, diagnostics):
    missing = extract_missing_headers(diagnostics)
    if not missing:
        return configured_args, []

    existing = set()
    for a in configured_args:
        if a.startswith("-I") and len(a) > 2:
            existing.add(os.path.abspath(a[2:]))

    file_dir = os.path.dirname(abs_filepath)
    project_root = find_header_search_base(file_dir)
    search_roots = [os.path.join(project_root, n) for n in HEADER_SEARCH_VENDOR_DIR_NAMES] + [project_root]

    added = []
    for header in missing[:MISSING_HEADERS_PER_FILE_LIMIT]:
        hit = find_header_dir(header, search_roots)
        if not hit:
            continue
        hit = os.path.abspath(hit)
        if hit in existing:
            continue
        configured_args.append(f"-I{hit}")
        existing.add(hit)
        added.append(hit)

    return configured_args, added

def find_compile_commands(start_dir):
    cur = os.path.abspath(start_dir)
    for _ in range(COMPILE_COMMANDS_SEARCH_MAX_PARENT_LEVELS):
        candidate = os.path.join(cur, "compile_commands.json")
        if os.path.isfile(candidate):
            return candidate
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    return None

def normpath(p):
    return os.path.normcase(os.path.abspath(p))

def clean_compile_args(raw_args, abs_filepath, lang, std):
    out = []
    skip_next = 0
    abs_norm = normpath(abs_filepath)
    for i, a in enumerate(raw_args):
        if skip_next:
            skip_next -= 1
            continue

        if i == 0 and a and not a.startswith("-"):
            continue

        if a in ("-c",):
            continue
        if a in ("-o", "-MF", "-MT", "-MQ", "--serialize-diagnostics"):
            skip_next = 1
            continue

        if a and not a.startswith("-"):
            try:
                if normpath(a) == abs_norm:
                    continue
            except Exception:
                pass

        out.append(a)

    has_lang = any(arg == "-x" for arg in out)
    has_std = any(arg.startswith("-std=") for arg in out)
    if not has_lang:
        out = ["-x", lang] + out
    if std and not has_std:
        out.append(f"-std={std}")
    return out

def load_compile_args_from_db(compile_commands_path, abs_filepath, lang, std):
    try:
        with open(compile_commands_path, "r", encoding="utf-8") as f:
            db = json.load(f)
    except Exception:
        return None

    abs_norm = normpath(abs_filepath)
    best = None
    for entry in db if isinstance(db, list) else []:
        file_field = entry.get("file")
        if not file_field:
            continue
        try:
            if normpath(file_field) == abs_norm:
                best = entry
                break
        except Exception:
            continue

    if not best:
        return None

    if "arguments" in best and isinstance(best["arguments"], list):
        raw_args = best["arguments"]
    else:
        cmd = best.get("command")
        if not isinstance(cmd, str) or not cmd.strip():
            return None
        raw_args = shlex.split(cmd)

    cleaned = clean_compile_args(raw_args, abs_filepath, lang, std)

    workdir = best.get("directory")
    if isinstance(workdir, str) and workdir.strip():
        cleaned.append(f"-I{workdir}")

    return cleaned

def process_file(filepath, compiler_args, std, use_include_infer, extra_includes, extra_args, compile_commands_path, auto_header_search):
    if not os.path.exists(filepath):
        print(f"Error: File '{filepath}' not found.", file=sys.stderr)
        sys.exit(1)

    abs_filepath = os.path.abspath(filepath)
    lang = "c" if abs_filepath.lower().endswith(".c") else "c++"
    file_dir = os.path.dirname(abs_filepath)

    configured_args = None
    db_path = compile_commands_path
    if not db_path:
        db_path = find_compile_commands(file_dir)
    if db_path:
        configured_args = load_compile_args_from_db(db_path, abs_filepath, lang, std)

    if configured_args is None:
        configured_args = list(compiler_args)
        configured_args[configured_args.index("c++")] = lang

    if use_include_infer:
        for d in infer_include_dirs(abs_filepath):
            configured_args.append(f"-I{d}")

    for d in extra_includes:
        configured_args.append(f"-I{d}")

    for a in extra_args:
        configured_args.append(a)

    index = clang.cindex.Index.create()
    
    try:
        # 当遇到找不到 Poco 等头文件时，这行仍会解析，只需忽略其语义类型错误即可
        tu = index.parse(abs_filepath, args=configured_args)
    except clang.cindex.TranslationUnitLoadError as e:
        print(f"Error parsing file: {e}", file=sys.stderr)
        sys.exit(1)

    if auto_header_search:
        configured_args, added = try_auto_add_missing_header_includes(abs_filepath, configured_args, tu.diagnostics)
        if added:
            try:
                tu = index.parse(abs_filepath, args=configured_args)
            except clang.cindex.TranslationUnitLoadError as e:
                print(f"Error parsing file: {e}", file=sys.stderr)
                sys.exit(1)

    print(f"# Outline for `{os.path.basename(abs_filepath)}`\n")
    walk_ast(tu.cursor, abs_filepath, 0)

def main():
    parser = argparse.ArgumentParser(description="Extract accurate C++ outline via Lexical Tokens.")
    parser.add_argument("file", help="Path to the C++ source or header file")
    parser.add_argument("--std", default="c++17", help="C++ standard to use")
    parser.add_argument("--compile-commands", default="", help="Path to compile_commands.json (optional)")
    parser.add_argument("--no-include-infer", action="store_true", help="Disable include dir inference")
    parser.add_argument("--no-auto-header-search", action="store_true", help="Disable auto search for missing headers")
    parser.add_argument("--extra-include", action="append", default=[], help="Add extra include directory (-I)")
    parser.add_argument("--extra-arg", action="append", default=[], help="Add extra compiler arg")
    
    args = parser.parse_args()

    configure_libclang_from_env()

    compiler_args = ["-x", "c++", f"-std={args.std}"]
    compile_commands_path = args.compile_commands.strip() or None
    use_include_infer = not args.no_include_infer
    auto_header_search = not args.no_auto_header_search
    extra_includes = [d for d in args.extra_include if isinstance(d, str) and d.strip()]
    extra_args = [a for a in args.extra_arg if isinstance(a, str) and a.strip()]

    process_file(
        args.file,
        compiler_args,
        args.std,
        use_include_infer,
        extra_includes,
        extra_args,
        compile_commands_path,
        auto_header_search,
    )

if __name__ == "__main__":
    main()
