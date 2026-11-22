/**
 * Registry of the supported languages with their parsers. Loads every
 * parser (including the TypeScript compiler), so it is only imported by the
 * analyzer bundle and the parser workers.
 */
import { AnalyzerRegistry } from './language';
import { LANGUAGES } from './languages';
import { parseSource } from './parser';
import type { ParsedFile } from './types';
import { TYPESCRIPT_LANGUAGE } from './typescriptLanguage';

/** Parser of each built-in language, by language id. */
const PARSERS: Readonly<Record<string, (filePath: string, content: string) => ParsedFile>> = {
  [TYPESCRIPT_LANGUAGE.id]: parseSource,
};

/**
 * Every built-in language with its parser, in the same order as {@link LANGUAGES}.
 *
 * @throws Error at load time if a registered language has no parser.
 */
export const ANALYZERS = new AnalyzerRegistry(
  LANGUAGES.languages.map((language) => {
    const parse = PARSERS[language.id];
    if (parse === undefined) {
      throw new Error(`Language "${language.id}" has no parser.`);
    }
    return { ...language, parse };
  }),
);

/**
 * Parses a file with the built-in analyzer of its language.
 *
 * @param filePath - Workspace-relative POSIX path.
 * @param content - File text.
 * @returns The parsed file.
 */
export function parseFile(filePath: string, content: string): ParsedFile {
  return ANALYZERS.parse(filePath, content);
}
