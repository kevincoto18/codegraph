/**
 * Definition of the Java language (without its parser, which lives in
 * `javaParser.ts` and loads the Tree-sitter grammar). Java resolves imports by
 * package and type name, not by path (see `scope.ts`).
 */
import type { LanguageDefinition } from './language';

/** Java: `.java` files. */
export const JAVA_LANGUAGE: LanguageDefinition = {
  id: 'java',
  displayName: 'Java',
  extensions: ['.java'],
  version: 1,
  listImportCandidates: () => [],
};
