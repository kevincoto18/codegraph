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
 * Top-level modules of the Python standard library (`sys.stdlib_module_names`).
 * Python 3 has no implicit relative imports, so `import collections` inside
 * a package never means a `collections.py` next to the importer.
 */
const STDLIB_MODULES: ReadonlySet<string> = new Set([
  'abc',
  'aifc',
  'antigravity',
  'argparse',
  'array',
  'ast',
  'asynchat',
  'asyncio',
  'asyncore',
  'atexit',
  'audioop',
  'base64',
  'bdb',
  'binascii',
  'binhex',
  'bisect',
  'builtins',
  'bz2',
  'cProfile',
  'calendar',
  'cgi',
  'cgitb',
  'chunk',
  'cmath',
  'cmd',
  'code',
  'codecs',
  'codeop',
  'collections',
  'colorsys',
  'compileall',
  'concurrent',
  'configparser',
  'contextlib',
  'contextvars',
  'copy',
  'copyreg',
  'crypt',
  'csv',
  'ctypes',
  'curses',
  'dataclasses',
  'datetime',
  'dbm',
  'decimal',
  'difflib',
  'dis',
  'distutils',
  'doctest',
  'email',
  'encodings',
  'ensurepip',
  'enum',
  'errno',
  'faulthandler',
  'fcntl',
  'filecmp',
  'fileinput',
  'fnmatch',
  'fractions',
  'ftplib',
  'functools',
  'gc',
  'genericpath',
  'getopt',
  'getpass',
  'gettext',
  'glob',
  'graphlib',
  'grp',
  'gzip',
  'hashlib',
  'heapq',
  'hmac',
  'html',
  'http',
  'idlelib',
  'imaplib',
  'imghdr',
  'imp',
  'importlib',
  'inspect',
  'io',
  'ipaddress',
  'itertools',
  'json',
  'keyword',
  'lib2to3',
  'linecache',
  'locale',
  'logging',
  'lzma',
  'mailbox',
  'mailcap',
  'marshal',
  'math',
  'mimetypes',
  'mmap',
  'modulefinder',
  'msilib',
  'msvcrt',
  'multiprocessing',
  'netrc',
  'nis',
  'nntplib',
  'nt',
  'ntpath',
  'nturl2path',
  'numbers',
  'opcode',
  'operator',
  'optparse',
  'os',
  'ossaudiodev',
  'pathlib',
  'pdb',
  'pickle',
  'pickletools',
  'pipes',
  'pkgutil',
  'platform',
  'plistlib',
  'poplib',
  'posix',
  'posixpath',
  'pprint',
  'profile',
  'pstats',
  'pty',
  'pwd',
  'py_compile',
  'pyclbr',
  'pydoc',
  'pydoc_data',
  'pyexpat',
  'queue',
  'quopri',
  'random',
  're',
  'readline',
  'reprlib',
  'resource',
  'rlcompleter',
  'runpy',
  'sched',
  'secrets',
  'select',
  'selectors',
  'shelve',
  'shlex',
  'shutil',
  'signal',
  'site',
  'smtpd',
  'smtplib',
  'sndhdr',
  'socket',
  'socketserver',
  'spwd',
  'sqlite3',
  'sre_compile',
  'sre_constants',
  'sre_parse',
  'ssl',
  'stat',
  'statistics',
  'string',
  'stringprep',
  'struct',
  'subprocess',
  'sunau',
  'symtable',
  'sys',
  'sysconfig',
  'syslog',
  'tabnanny',
  'tarfile',
  'telnetlib',
  'tempfile',
  'termios',
  'textwrap',
  'this',
  'threading',
  'time',
  'timeit',
  'tkinter',
  'token',
  'tokenize',
  'tomllib',
  'trace',
  'traceback',
  'tracemalloc',
  'tty',
  'turtle',
  'turtledemo',
  'types',
  'typing',
  'unicodedata',
  'unittest',
  'urllib',
  'uu',
  'uuid',
  'venv',
  'warnings',
  'wave',
  'weakref',
  'webbrowser',
  'winreg',
  'winsound',
  'wsgiref',
  'xdrlib',
  'xml',
  'xmlrpc',
  'zipapp',
  'zipfile',
  'zipimport',
  'zlib',
  'zoneinfo',
]);

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
  // Scripts run from their own folder, so it is a root too; but standard library
  // modules are never looked for there (only a root module can shadow them).
  if (!STDLIB_MODULES.has(parts[0] ?? '')) {
    for (let folder = posix.dirname(fromFile); folder !== '.'; folder = posix.dirname(folder)) {
      roots.push(folder);
    }
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
  // 3: classes, signatures and uses for call resolution with types; stdlib imports.
  version: 3,
  listImportCandidates: listPythonImportCandidates,
};
