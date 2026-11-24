/**
 * Name-based import and call resolution for languages whose files see each
 * other through namespaces and types instead of file paths (Java, C#, Go).
 */
import type { RelPath } from '../../shared';
import type { LanguageDefinition } from './language';
import type { FileIndex, WorkspaceIndex } from './linker';
import type { SymbolTable } from './symbols';
import { namespaceKey, namespaceSetKey } from './symbols';
import type { ParsedCall, ParsedFile, ParsedFunction } from './types';

/** How far base classes are followed when looking for an inherited method. */
const MAX_BASE_DEPTH = 6;

/** Prefix of a type that is the result of a call (`call:pkg.New`). */
export const CALL_RESULT_PREFIX = 'call:';

/** What a file of a namespace-based language can see. */
export interface SymbolScope {
  /** Language id. */
  readonly language: string;
  /** Simple (or `alias.Type` in Go) type name → files that declare it. */
  readonly visibleTypes: ReadonlyMap<string, readonly RelPath[]>;
  /** Other files of the same namespace or package. */
  readonly packageFiles: readonly RelPath[];
  /** Go import alias → files of the imported package. */
  readonly packageAliases: ReadonlyMap<string, readonly RelPath[]>;
  /** Files reachable through namespace or package imports → line of the import. */
  readonly importedFiles: ReadonlyMap<RelPath, number>;
  /** Files of single-type imports, with the line of the import (import edges). */
  readonly typeImports: readonly (readonly [RelPath, number])[];
  /** Symbol keys whose changes must re-index this file. */
  readonly watchKeys: readonly string[];
  /** Every file this file's calls may resolve into. */
  readonly dependencies: readonly RelPath[];
}

/** A resolved call target. */
export interface CallTarget {
  /** Function id. */
  readonly id: string;
  /** File of the function. */
  readonly file: RelPath;
}

/**
 * Splits `a.b.Type` into namespace and simple name.
 *
 * @param qualifiedName - Dotted name.
 * @returns The namespace (empty when there is none) and the last segment.
 */
export function splitQualifiedName(qualifiedName: string): {
  readonly namespace: string;
  readonly name: string;
} {
  const dot = qualifiedName.lastIndexOf('.');
  return dot === -1
    ? { namespace: '', name: qualifiedName }
    : { namespace: qualifiedName.slice(0, dot), name: qualifiedName.slice(dot + 1) };
}

/**
 * Lists a namespace and its parents (`A.B.C`, `A.B`, `A`).
 *
 * @param namespace - Dotted namespace.
 * @returns The namespaces, innermost first.
 */
function withParents(namespace: string): string[] {
  const parts = namespace.split('.');
  return parts.map((_, index) => parts.slice(0, parts.length - index).join('.'));
}

/**
 * Adds files to a type entry, keeping earlier (higher priority) entries.
 *
 * @param types - Visible types being built.
 * @param name - Type name.
 * @param files - Declaring files.
 * @param override - Replace an existing entry (own and explicitly imported types win).
 */
function addVisibleType(
  types: Map<string, readonly RelPath[]>,
  name: string,
  files: readonly RelPath[],
  override = false,
): void {
  if (files.length > 0 && (override || !types.has(name))) {
    types.set(name, files);
  }
}

/**
 * Computes what a file of a namespace-based language can see. Returns
 * `null` for path-based languages (TypeScript, Python).
 *
 * @param parsed - Parsed file.
 * @param language - Its language.
 * @param symbols - Workspace symbol table (already containing the file).
 * @returns The scope, or `null`.
 */
export function buildSymbolScope(
  parsed: ParsedFile,
  language: LanguageDefinition | undefined,
  symbols: SymbolTable,
): SymbolScope | null {
  if (language === undefined || parsed.namespace === undefined) {
    return null;
  }
  const lang = language.id;
  const own = parsed.namespace;
  const visibleTypes = new Map<string, readonly RelPath[]>();
  const packageAliases = new Map<string, readonly RelPath[]>();
  const importedFiles = new Map<RelPath, number>();
  const typeImports: (readonly [RelPath, number])[] = [];
  const watchKeys = new Set<string>([namespaceKey(lang, own)]);

  for (const type of parsed.types ?? []) {
    addVisibleType(visibleTypes, type.name, [parsed.filePath], true);
  }

  // The file's own namespace, then (C#) its parents.
  const ownNamespaces = language.namespacesSeeParents === true ? withParents(own) : [own];
  for (const namespace of ownNamespaces) {
    watchKeys.add(namespaceKey(lang, namespace));
    for (const [name, files] of symbols.typesInNamespace(lang, namespace)) {
      addVisibleType(visibleTypes, name, files);
    }
  }

  for (const parsedImport of parsed.imports) {
    switch (parsedImport.target) {
      case 'type': {
        const { namespace, name } = splitQualifiedName(parsedImport.specifier);
        watchKeys.add(namespaceKey(lang, namespace));
        const files = symbols.filesDeclaringType(lang, namespace, name);
        const localNames = parsedImport.bindings.map((binding) => binding.localName);
        for (const localName of localNames.length === 0 ? [name] : localNames) {
          addVisibleType(visibleTypes, localName, files, true);
        }
        files.forEach((file) => typeImports.push([file, parsedImport.line]));
        break;
      }
      case 'namespace': {
        watchKeys.add(namespaceKey(lang, parsedImport.specifier));
        for (const [name, files] of symbols.typesInNamespace(lang, parsedImport.specifier)) {
          addVisibleType(visibleTypes, name, files);
          files.forEach((file) => {
            if (!importedFiles.has(file)) {
              importedFiles.set(file, parsedImport.line);
            }
          });
        }
        break;
      }
      case 'package': {
        watchKeys.add(namespaceSetKey(lang));
        const directory = language.resolvePackage?.(
          parsedImport.specifier,
          symbols.namespaces(lang),
        );
        if (directory === null || directory === undefined) {
          break;
        }
        watchKeys.add(namespaceKey(lang, directory));
        const files = symbols.filesInNamespace(lang, directory);
        for (const binding of parsedImport.bindings) {
          packageAliases.set(binding.localName, files);
          for (const [name, typeFiles] of symbols.typesInNamespace(lang, directory)) {
            addVisibleType(visibleTypes, `${binding.localName}.${name}`, typeFiles);
          }
        }
        files.forEach((file) => {
          if (!importedFiles.has(file)) {
            importedFiles.set(file, parsedImport.line);
          }
        });
        break;
      }
      default:
        break;
    }
  }

  const packageFiles = symbols
    .filesInNamespace(lang, own)
    .filter((file) => file !== parsed.filePath);
  const dependencies = new Set<RelPath>(packageFiles);
  for (const files of [...visibleTypes.values(), ...packageAliases.values()]) {
    files.forEach((file) => dependencies.add(file));
  }
  dependencies.delete(parsed.filePath);

  return {
    language: lang,
    visibleTypes,
    packageFiles,
    packageAliases,
    importedFiles,
    typeImports,
    watchKeys: [...watchKeys],
    dependencies: [...dependencies],
  };
}

/**
 * Files that declare a type visible from a file.
 *
 * @param typeRef - Simple name, `alias.Type` (Go) or dotted name.
 * @param scope - Scope of the file the name is written in.
 * @returns The declaring files (empty when unknown).
 */
function filesOfType(typeRef: string, scope: SymbolScope): readonly RelPath[] {
  return (
    scope.visibleTypes.get(typeRef) ??
    scope.visibleTypes.get(splitQualifiedName(typeRef).name) ??
    []
  );
}

/**
 * Files that declare the type a call is made on, when it is visible from the
 * caller (used to draw the import edge of `new Repo()` without a constructor).
 *
 * @param call - Parsed call.
 * @param fileIndex - File of the caller.
 * @returns The declaring files (empty when unknown or not typed).
 */
export function receiverTypeFiles(call: ParsedCall, fileIndex: FileIndex): readonly RelPath[] {
  const typeRef = call.receiverField === undefined ? call.receiverType : undefined;
  if (fileIndex.scope === null || typeRef === undefined || typeRef.startsWith(CALL_RESULT_PREFIX)) {
    return [];
  }
  return filesOfType(typeRef, fileIndex.scope);
}

/**
 * Finds a method of a type, following base classes.
 *
 * @param typeRef - Type name as written in the file.
 * @param name - Method name.
 * @param from - File the type name is written in.
 * @param workspace - Every indexed file.
 * @param depth - Base classes followed so far.
 * @returns The method, or `null`.
 */
function findMethod(
  typeRef: string,
  name: string,
  from: FileIndex,
  workspace: WorkspaceIndex,
  depth = 0,
): CallTarget | null {
  if (from.scope === null || depth > MAX_BASE_DEPTH) {
    return null;
  }
  if (typeRef.startsWith(CALL_RESULT_PREFIX)) {
    const result = resultTypeOf(typeRef.slice(CALL_RESULT_PREFIX.length), from, workspace);
    return result === null
      ? null
      : findMethod(result.type, name, result.from, workspace, depth + 1);
  }
  const typeName = splitQualifiedName(typeRef).name;
  const files = filesOfType(typeRef, from.scope);
  for (const file of files) {
    const id = workspace.get(file)?.methodsByClass.get(typeName)?.get(name);
    if (id !== undefined) {
      return { id, file };
    }
  }
  for (const file of files) {
    const target = workspace.get(file);
    const declaration = target?.parsed.types?.find((type) => type.name === typeName);
    for (const base of declaration?.bases ?? []) {
      const inherited =
        target === undefined ? null : findMethod(base, name, target, workspace, depth + 1);
      if (inherited !== null) {
        return inherited;
      }
    }
  }
  return null;
}

/**
 * Finds the declared type of a field, following base classes.
 *
 * @param typeRef - Type that owns the field.
 * @param field - Field name.
 * @param from - File the type name is written in.
 * @param workspace - Every indexed file.
 * @param depth - Base classes followed so far.
 * @returns The field type and the file it is written in, or `null`.
 */
function findFieldType(
  typeRef: string,
  field: string,
  from: FileIndex,
  workspace: WorkspaceIndex,
  depth = 0,
): { readonly type: string; readonly from: FileIndex } | null {
  if (from.scope === null || depth > MAX_BASE_DEPTH) {
    return null;
  }
  const typeName = splitQualifiedName(typeRef).name;
  for (const file of filesOfType(typeRef, from.scope)) {
    const target = workspace.get(file);
    const declaration = target?.parsed.types?.find((type) => type.name === typeName);
    if (target === undefined || declaration === undefined) {
      continue;
    }
    const type = declaration.fields[field];
    if (type !== undefined) {
      return { type, from: target };
    }
    for (const base of declaration.bases) {
      const inherited = findFieldType(base, field, target, workspace, depth + 1);
      if (inherited !== null) {
        return inherited;
      }
    }
  }
  return null;
}

/**
 * Finds the result type of a function called as `f` or `pkg.F`.
 *
 * @param callee - Called function as written.
 * @param from - File of the call.
 * @param workspace - Every indexed file.
 * @returns The result type and the file it is written in, or `null`.
 */
function resultTypeOf(
  callee: string,
  from: FileIndex,
  workspace: WorkspaceIndex,
): { readonly type: string; readonly from: FileIndex } | null {
  const scope = from.scope;
  if (scope === null) {
    return null;
  }
  const { namespace: alias, name } = splitQualifiedName(callee);
  const files =
    alias === '' ? [from.parsed.filePath, ...scope.packageFiles] : scope.packageAliases.get(alias);
  const target = files === undefined ? null : findFunction(files, name, workspace);
  const index = target === null ? undefined : workspace.get(target.file);
  const fn = index?.functions.find((candidate) => candidate.id === target?.id);
  const type = fn?.parsed.resultType;
  return index === undefined || type === undefined ? null : { type, from: index };
}

/**
 * Finds a top-level function in a list of files.
 *
 * @param files - Files to search.
 * @param name - Function name.
 * @param workspace - Every indexed file.
 * @returns The function, or `null`.
 */
function findFunction(
  files: readonly RelPath[],
  name: string,
  workspace: WorkspaceIndex,
): CallTarget | null {
  for (const file of files) {
    const id = workspace.get(file)?.functionsByName.get(name);
    if (id !== undefined) {
      return { id, file };
    }
  }
  return null;
}

/**
 * Resolves a call of a namespace-based language:
 * - `save()` (Java, C#: implicit `this`) and `this.save()`: the caller's class and its bases
 * - `helper()` (Go): the file, then the other files of the package
 * - `db.Open()` (Go): a function of the imported package
 * - `repo.save()` with an inferred type: a method of that type (or of its bases)
 * - `this.repo.save()` / `s.repo.Save()`: a method of the field's type
 * - `Repo.open()`: a static method of the type
 *
 * @param call - Parsed call.
 * @param caller - Calling function.
 * @param fileIndex - File of the caller (with a scope).
 * @param workspace - Every indexed file.
 * @returns The called function, or `null`.
 */
export function resolveScopedCall(
  call: ParsedCall,
  caller: ParsedFunction,
  fileIndex: FileIndex,
  workspace: WorkspaceIndex,
): CallTarget | null {
  const scope = fileIndex.scope;
  if (scope === null) {
    return null;
  }
  const self = fileIndex.parsed.filePath;
  switch (call.kind) {
    case 'this-member':
      return caller.className === undefined
        ? null
        : findMethod(caller.className, call.name, fileIndex, workspace);
    case 'identifier':
      return findFunction([self, ...scope.packageFiles], call.name, workspace);
    case 'member': {
      if (call.receiverType !== undefined) {
        if (call.receiverField !== undefined) {
          const field = findFieldType(call.receiverType, call.receiverField, fileIndex, workspace);
          return field === null ? null : findMethod(field.type, call.name, field.from, workspace);
        }
        return findMethod(call.receiverType, call.name, fileIndex, workspace);
      }
      if (call.receiver === undefined) {
        return null;
      }
      const packageFiles = scope.packageAliases.get(call.receiver);
      if (packageFiles !== undefined) {
        return findFunction(packageFiles, call.name, workspace);
      }
      return findMethod(call.receiver, call.name, fileIndex, workspace);
    }
  }
}
