/**
 * Definition of the Python language: files and module resolution (the
 * parser, which needs Tree-sitter, lives in `pythonParser.ts`).
 */
import { posix } from 'node:path';

import type { RelPath } from '../../shared';
import type { LanguageDefinition } from './language';

/** Source roots tried for absolute imports, besides the importer's folders. */
const PYTHON_SOURCE_ROOTS: readonly RelPath[] = ['', 'src'];

/**
 * Lists the files a Python module path may refer to.
 *
 * @param modulePath - Workspace-relative path of the module, without extension.
 * @returns `module.py` then `module/__init__.py`.
 */
function moduleFiles(modulePath: RelPath): RelPath[] {
  return modulePath === '' ? ['__init__.py'] : [`${modulePath}.py`, `${modulePath}/__init__.py`];
}

/**
 * Lists the workspace files a Python import may refer to, in priority order.
 *
 * Specifiers are module paths as written, with leading dots for relative
 * imports: `app.models`, `.models`, `..pkg.mod`, `.` (the current package).
 *
 * - Relative imports start at the importer's package (one dot) and go up one
 *   folder per extra dot.
 * - Absolute imports are tried from the workspace root, from `src/`, and from
 *   every folder above the importer (scripts run from their own folder).
 *
 * @param fromFile - Workspace-relative POSIX path of the importing file.
 * @param specifier - Module path as written in the import.
 * @returns Candidate files (empty if the import leaves the workspace).
 */
export function listPythonImportCandidates(fromFile: RelPath, specifier: string): RelPath[] {
  const dots = /^\.*/.exec(specifier)?.[0].length ?? 0;
  const parts = specifier
    .slice(dots)
    .split('.')
    .filter((part) => part !== '');

  if (dots > 0) {
    let base = posix.dirname(fromFile);
    for (let level = 1; level < dots; level += 1) {
      if (base === '.') {
        return []; // Above the workspace root.
      }
      base = posix.dirname(base);
    }
    const root = base === '.' ? '' : base;
    if (parts.length === 0) {
      return [root === '' ? '__init__.py' : `${root}/__init__.py`];
    }
    return moduleFiles(posix.join(root, ...parts));
  }

  if (parts.length === 0) {
    return [];
  }
  const roots = [...PYTHON_SOURCE_ROOTS];
  for (let folder = posix.dirname(fromFile); folder !== '.'; folder = posix.dirname(folder)) {
    roots.push(folder);
  }
  const candidates = [...new Set(roots)].flatMap((root) =>
    moduleFiles(root === '' ? parts.join('/') : posix.join(root, ...parts)),
  );
  return [...new Set(candidates)];
}

/** Python: `.py` files. */
export const PYTHON_LANGUAGE: LanguageDefinition = {
  id: 'python',
  displayName: 'Python',
  extensions: ['.py'],
  version: 1,
  listImportCandidates: listPythonImportCandidates,
};
