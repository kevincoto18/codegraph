/**
 * Tree-sitter runtime shared by every Tree-sitter-based language: loads the
 * WASM engine and grammars once, on first use.
 *
 * @remarks Grammars come from `@vscode/tree-sitter-wasm` (the builds VS Code
 * itself uses). The build copies the needed `.wasm` files to `dist/grammars`;
 * when running from sources (tests, scripts) they are read from `node_modules`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { Language, Parser } from '@vscode/tree-sitter-wasm';

/** WASM file of the Tree-sitter engine. */
const ENGINE_FILE = 'tree-sitter.wasm';

/** Folder of the grammars next to the bundles (`dist/grammars`). */
const BUNDLED_GRAMMARS = join(__dirname, 'grammars');

/** Folder of the grammars when running from sources. */
const PACKAGE_GRAMMARS = join(process.cwd(), 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm');

let grammarDirectory: string | undefined;
let engineReady: Promise<void> | undefined;
const languages = new Map<string, Promise<Language>>();

/**
 * Returns the folder that contains the `.wasm` files.
 *
 * @returns The bundled folder when it exists, otherwise the package folder.
 */
export function getGrammarDirectory(): string {
  grammarDirectory ??= existsSync(BUNDLED_GRAMMARS) ? BUNDLED_GRAMMARS : PACKAGE_GRAMMARS;
  return grammarDirectory;
}

/**
 * Overrides the folder of the `.wasm` files (scripts and tests).
 *
 * @param directory - Absolute folder path.
 */
export function setGrammarDirectory(directory: string): void {
  grammarDirectory = directory;
}

/**
 * Loads a grammar (and the engine, the first time).
 *
 * @param grammarFile - File name of the grammar, e.g. `tree-sitter-python.wasm`.
 * @returns The language, cached for the session.
 */
export function loadTreeSitterLanguage(grammarFile: string): Promise<Language> {
  const cached = languages.get(grammarFile);
  if (cached !== undefined) {
    return cached;
  }
  engineReady ??= Parser.init({ locateFile: () => join(getGrammarDirectory(), ENGINE_FILE) });
  const loading = engineReady.then(() => Language.load(join(getGrammarDirectory(), grammarFile)));
  languages.set(grammarFile, loading);
  return loading;
}

/**
 * Creates a parser for a loaded language.
 *
 * @param language - Language returned by {@link loadTreeSitterLanguage}.
 * @returns A parser (reuse it: parsers are cheap to keep and costly to create).
 */
export function createTreeSitterParser(language: Language): Parser {
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}
