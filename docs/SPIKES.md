# Spikes

What was verified, how, and what it decided. Blueprint section numbers refer to `docs/BLUEPRINT.md`.

## Tree-sitter for the context engine (11 November 2026)

**Question.** Can the context engine (blueprint section 7) parse Python, TypeScript and JavaScript with tree-sitter offline, inside a VS Code extension, without native modules or install scripts? If not, fall back to the regex extractor in `src/changeset/symbols.ts`.

**Verified.**

- Package: `@vscode/tree-sitter-wasm@0.3.1` (MIT, published by the VS Code team). It ships the web-tree-sitter runtime (`wasm/tree-sitter.js`, `tree-sitter.wasm`) with grammars built against it, including `tree-sitter-python.wasm`, `tree-sitter-typescript.wasm`, `tree-sitter-tsx.wasm` and `tree-sitter-javascript.wasm`. Because the runtime and grammars come from one package, there is no ABI mismatch between them.
- No install script, no native build, no network at runtime: grammars load from local files.
- API used: `Parser.init({ locateFile })`, `Language.load(path)`, `new Parser().setLanguage(lang)`, `parser.parse(text)`, `Node.namedChildren`, `Node.childForFieldName`, `tree.delete()`. Types come from `wasm/web-tree-sitter.d.ts` and resolve under strict TypeScript.
- Runtime init plus loading the Python grammar took about 12 ms on this machine (Node 26.8, Apple Silicon).
- Works under Vitest (ESM) and in an esbuild CJS bundle, with WASM files loaded from a copied folder.

**Decision.** Use tree-sitter. `src/context/symbols.ts` builds a parser with `createParser({ wasmDir })`. The build copies the five WASM files to `dist/wasm`, and `.vscodeignore` ships them in the `.vsix`. If loading fails (files missing, or an unsupported runtime), `createParser` falls back to the regex parser and reports the reason through `onFallback`. `toSymbolExtractor` plugs the tree-sitter parser into the change-set `SymbolExtractor` hook.

**Node types relied on.** Python: `class_definition`, `function_definition`, `decorated_definition`, `expression_statement` > `assignment`, `import_statement`, `import_from_statement` (field `module_name`), `aliased_import`. TypeScript/JavaScript: `function_declaration`, `generator_function_declaration`, `class_declaration`, `abstract_class_declaration`, `class_body` > `method_definition`, `abstract_method_signature`, `interface_declaration`, `type_alias_declaration`, `enum_declaration`, `lexical_declaration`/`variable_declaration` > `variable_declarator`, `import_statement` (field `source`), `export_statement` (fields `declaration`, `source`), `export_clause` > `export_specifier`. All are covered by `test/unit/context/symbols.test.ts`, so a grammar upgrade that renames one fails a test.

**Sizes.** The five WASM files total 3.8 MB uncompressed in `dist/wasm`.
