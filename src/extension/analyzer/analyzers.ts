/**
 * Registry of the supported languages with their parsers. Loads every
 * parser (including the TypeScript compiler and the Tree-sitter engine), so it
 * is only imported by the analyzer bundle and the parser workers.
 */
import type { LanguageAnalyzer } from './language';
import { AnalyzerRegistry } from './language';
import { LANGUAGES } from './languages';
import { parseSource } from './parser';
import { parsePython, preparePython } from './pythonParser';
import { PYTHON_LANGUAGE } from './pythonLanguage';
import type { ParsedFile } from './types';
import { TYPESCRIPT_LANGUAGE } from './typescriptLanguage';

/** Parser part of an analyzer. */
type ParserImplementation = Pick<LanguageAnalyzer, 'parse' | 'prepare'>;

/** Parser of each built-in language, by language id. */
const PARSERS: Readonly<Record<string, ParserImplementation>> = {
  [TYPESCRIPT_LANGUAGE.id]: { parse: parseSource },
  [PYTHON_LANGUAGE.id]: { parse: parsePython, prepare: preparePython },
};

/**
 * Every built-in language with its parser, in the same order as {@link LANGUAGES}.
 *
 * @throws Error at load time if a registered language has no parser.
 */
export const ANALYZERS = new AnalyzerRegistry(
  LANGUAGES.languages.map((language) => {
    const implementation = PARSERS[language.id];
    if (implementation === undefined) {
      throw new Error(`Language "${language.id}" has no parser.`);
    }
    return { ...language, ...implementation };
  }),
);

/**
 * Parses a file with the built-in analyzer of its language. Languages that
 * need preparation must have been prepared with `ANALYZERS.prepare()`.
 *
 * @param filePath - Workspace-relative POSIX path.
 * @param content - File text.
 * @returns The parsed file.
 */
export function parseFile(filePath: string, content: string): ParsedFile {
  return ANALYZERS.parse(filePath, content);
}
