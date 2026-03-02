#!/usr/bin/env python3
import sys
import os
import argparse
import clang.cindex
from clang.cindex import CursorKind

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
        (" )", ")"), (" ) ", ") "),
        (" , ", ", "), (" ,", ", "),
        (" < ", "<"), (" <", "<"), ("< ", "<"),
        (" > ", ">"), (" >", ">"), ("> ", ">"),
        (" & ", "& "), (" * ", "* "),
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

def walk_ast(cursor, target_filepath, current_depth=0):
    node_file = cursor.location.file.name if cursor.location.file else None
    
    if node_file and os.path.abspath(node_file) != target_filepath:
        return

    printed = False
    if cursor.kind in TARGET_KINDS and cursor.spelling:
        kind_label = TARGET_KINDS[cursor.kind]
        # 👇 这里替换为我们新写的 Token 原文提取函数
        signature = get_raw_signature(cursor)
        line_num = cursor.location.line
        
        if cursor.is_definition() or cursor.kind in (CursorKind.CXX_METHOD, CursorKind.FUNCTION_DECL):
            indent = "  " * current_depth
            print(f"{indent}- [Line {line_num}] **{kind_label}** `{signature}`")
            printed = True

    next_depth = current_depth + 1 if printed else current_depth
    for child in cursor.get_children():
        walk_ast(child, target_filepath, next_depth)

def process_file(filepath, compiler_args):
    if not os.path.exists(filepath):
        print(f"Error: File '{filepath}' not found.", file=sys.stderr)
        sys.exit(1)

    abs_filepath = os.path.abspath(filepath)
    index = clang.cindex.Index.create()
    
    file_dir = os.path.dirname(abs_filepath)
    compiler_args.append(f"-I{file_dir}")

    try:
        # 当遇到找不到 Poco 等头文件时，这行仍会解析，只需忽略其语义类型错误即可
        tu = index.parse(abs_filepath, args=compiler_args)
    except clang.cindex.TranslationUnitLoadError as e:
        print(f"Error parsing file: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"# Outline for `{os.path.basename(abs_filepath)}`\n")
    walk_ast(tu.cursor, abs_filepath, 0)

def main():
    parser = argparse.ArgumentParser(description="Extract accurate C++ outline via Lexical Tokens.")
    parser.add_argument("file", help="Path to the C++ source or header file")
    parser.add_argument("--std", default="c++17", help="C++ standard to use")
    
    args = parser.parse_args()

    # 关闭多余参数，保持精简，反正我们现在直接拿纯文本 Token 了
    compiler_args = ["-x", "c++", f"-std={args.std}"]

    process_file(args.file, compiler_args)

if __name__ == "__main__":
    main()