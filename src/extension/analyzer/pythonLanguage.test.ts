import { describe, expect, it } from 'vitest';

import { listPythonImportCandidates } from './pythonLanguage';

describe('listPythonImportCandidates', () => {
  it('resolves relative imports from the importer package, one folder per extra dot', () => {
    expect(listPythonImportCandidates('app/main.py', '.utils')).toEqual([
      'app/utils.py',
      'app/utils/__init__.py',
    ]);
    expect(listPythonImportCandidates('app/services/user.py', '..utils')).toEqual([
      'app/utils.py',
      'app/utils/__init__.py',
    ]);
    expect(listPythonImportCandidates('app/services/user.py', '..models.user')).toEqual([
      'app/models/user.py',
      'app/models/user/__init__.py',
    ]);
  });

  it('maps the current package to its __init__.py', () => {
    expect(listPythonImportCandidates('app/main.py', '.')).toEqual(['app/__init__.py']);
    expect(listPythonImportCandidates('app/sub/x.py', '..')).toEqual(['app/__init__.py']);
    expect(listPythonImportCandidates('main.py', '.')).toEqual(['__init__.py']);
  });

  it('never leaves the workspace', () => {
    expect(listPythonImportCandidates('main.py', '..x')).toEqual([]);
  });

  it('tries absolute imports from the root, src/ and the importer folders', () => {
    expect(listPythonImportCandidates('tools/scripts/run.py', 'app.models')).toEqual([
      'app/models.py',
      'app/models/__init__.py',
      'src/app/models.py',
      'src/app/models/__init__.py',
      'tools/scripts/app/models.py',
      'tools/scripts/app/models/__init__.py',
      'tools/app/models.py',
      'tools/app/models/__init__.py',
    ]);
    expect(listPythonImportCandidates('main.py', '')).toEqual([]);
  });

  it('looks for standard library modules only at the root and in src/', () => {
    expect(listPythonImportCandidates('shop/domain/events.py', 'collections')).toEqual([
      'collections.py',
      'collections/__init__.py',
      'src/collections.py',
      'src/collections/__init__.py',
    ]);
    expect(listPythonImportCandidates('shop/domain/events.py', 'json.decoder')).toEqual([
      'json/decoder.py',
      'json/decoder/__init__.py',
      'src/json/decoder.py',
      'src/json/decoder/__init__.py',
    ]);
  });
});
