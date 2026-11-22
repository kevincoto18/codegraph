/**
 * Definition of the TypeScript / JavaScript language (without its parser,
 * which lives in `parser.ts` and embeds the TypeScript compiler).
 */
import type { LanguageDefinition } from './language';
import { TYPESCRIPT_EXTENSIONS, listImportCandidates } from './resolver';

/** Suffix of TypeScript declaration files, which contain no function bodies. */
const DECLARATION_FILE_SUFFIX = '.d.ts';

/** TypeScript and JavaScript: `.ts`, `.tsx`, `.js`, `.jsx`, except `.d.ts` files. */
export const TYPESCRIPT_LANGUAGE: LanguageDefinition = {
  id: 'typescript',
  displayName: 'TypeScript / JavaScript',
  extensions: TYPESCRIPT_EXTENSIONS,
  version: 1,
  isExcluded: (filePath) => filePath.endsWith(DECLARATION_FILE_SUFFIX),
  listImportCandidates,
};
