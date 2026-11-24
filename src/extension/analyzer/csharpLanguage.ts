/**
 * Definition of the C# language (without its parser, which lives in
 * `csharpParser.ts`). C# resolves `using` directives by namespace and type
 * name (see `scope.ts`), and code in `A.B.C` also sees `A.B` and `A`.
 */
import type { LanguageDefinition } from './language';

/** C#: `.cs` files. */
export const CSHARP_LANGUAGE: LanguageDefinition = {
  id: 'csharp',
  displayName: 'C#',
  extensions: ['.cs'],
  version: 1,
  listImportCandidates: () => [],
  namespacesSeeParents: true,
};
