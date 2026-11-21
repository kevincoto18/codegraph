/**
 * Single-file static analysis built on the TypeScript Compiler API.
 *
 * @remarks Uses `ts.createSourceFile` only (no `Program`, no type checker), so
 * each file is parsed independently and cheaply. The output is raw: module
 * specifiers and call targets are resolved later by the linker.
 */
import * as ts from 'typescript';

import type { FunctionKind, RelPath } from '../../shared';
import type {
  ImportBinding,
  ParsedCall,
  ParsedExport,
  ParsedFile,
  ParsedFunction,
  ParsedImport,
} from './types';

/** Name used for anonymous default exports (`export default () => {}`). */
const DEFAULT_EXPORT_NAME = 'default';

/** Name of the CommonJS loader function. */
const REQUIRE_IDENTIFIER = 'require';

/** Function-valued expressions that can back a graph node. */
type FunctionExpressionLike = ts.ArrowFunction | ts.FunctionExpression;

/** Target of a CommonJS export assignment. */
type CommonJsExportTarget =
  { readonly kind: 'module' } | { readonly kind: 'named'; readonly name: string };

/** Input needed to build a {@link ParsedFunction}. */
interface FunctionDescriptor {
  readonly name: string;
  readonly className?: string;
  readonly functionKind: FunctionKind;
  /** Node whose start line is reported as the function's line. */
  readonly declaration: ts.Node;
  /** Node whose end line is reported and whose subtree is scanned for calls. */
  readonly body: ts.Node;
  readonly exported: boolean;
}

/**
 * Version of the parser output format. Bump it whenever `parseSource` starts
 * producing different results, so persisted caches are discarded.
 */
export const PARSER_VERSION = 1;

/**
 * Parses one source file into raw imports, functions, calls and exports.
 *
 * @param filePath - Workspace-relative POSIX path (also selects JS/TS/JSX/TSX parsing).
 * @param content - Full text of the file.
 * @returns The raw analysis of the file. Syntax errors never throw: the
 *   TypeScript parser recovers and whatever could be parsed is returned.
 */
export function parseSource(filePath: RelPath, content: string): ParsedFile {
  // Parent pointers are not needed (positions are resolved against the
  // source file explicitly), and skipping them makes parsing ~30% faster.
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    false,
    getScriptKind(filePath),
  );
  const exports = collectExports(sourceFile);
  const exportedLocalNames = new Set(exports.map((entry) => entry.localName));

  return {
    filePath,
    imports: collectImports(sourceFile),
    functions: collectFunctions(sourceFile, exportedLocalNames),
    exports,
  };
}

// ---------------------------------------------------------------------------
// Generic AST helpers
// ---------------------------------------------------------------------------

/**
 * Selects the parser mode from the file extension.
 *
 * @param filePath - File path ending in `.ts`, `.tsx`, `.js` or `.jsx`.
 * @returns The matching TypeScript script kind (TS by default).
 */
function getScriptKind(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) {
    return ts.ScriptKind.TSX;
  }
  if (filePath.endsWith('.jsx')) {
    return ts.ScriptKind.JSX;
  }
  if (filePath.endsWith('.js')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

/**
 * Computes the 1-based line where a node starts (ignoring leading trivia).
 *
 * @param node - AST node.
 * @param sourceFile - File that contains the node.
 * @returns 1-based start line.
 */
function getStartLine(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/**
 * Computes the 1-based line where a node ends.
 *
 * @param node - AST node.
 * @param sourceFile - File that contains the node.
 * @returns 1-based end line.
 */
function getEndLine(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
}

/**
 * Checks whether a node carries a given modifier keyword.
 *
 * @param node - AST node.
 * @param kind - Modifier keyword kind (e.g. `ExportKeyword`).
 * @returns `true` if the modifier is present.
 */
function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

/**
 * Strips wrappers that do not change runtime value: parentheses, `as`,
 * `satisfies`, `<T>` assertions and non-null assertions.
 *
 * @param expression - Expression to unwrap.
 * @returns The innermost wrapped expression.
 */
function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * Checks whether an expression is an arrow function or function expression.
 *
 * @param expression - Expression to inspect (already unwrapped).
 * @returns `true` if the expression defines a function.
 */
function isFunctionExpressionLike(expression: ts.Expression): expression is FunctionExpressionLike {
  return ts.isArrowFunction(expression) || ts.isFunctionExpression(expression);
}

/**
 * Maps a function expression to the node kind reported in the graph.
 *
 * @param expression - Arrow function or function expression.
 * @returns `arrow` for arrow functions, `function` otherwise.
 */
function getExpressionFunctionKind(expression: FunctionExpressionLike): FunctionKind {
  return ts.isArrowFunction(expression) ? 'arrow' : 'function';
}

/**
 * Reads the static text of a property name.
 *
 * @param name - Property name node.
 * @returns The name text, or `null` for computed names (`[key]`).
 */
function getPropertyNameText(name: ts.PropertyName): string | null {
  if (
    ts.isIdentifier(name) ||
    ts.isPrivateIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return null;
}

// ---------------------------------------------------------------------------
// CommonJS helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the specifier of a `require('x')` call.
 *
 * @param expression - Expression to inspect (already unwrapped).
 * @returns The required specifier, or `null` if the expression is not a
 *   single-argument `require` call with a string literal.
 */
function getRequireSpecifier(expression: ts.Expression): string | null {
  if (
    !ts.isCallExpression(expression) ||
    !ts.isIdentifier(expression.expression) ||
    expression.expression.text !== REQUIRE_IDENTIFIER
  ) {
    return null;
  }
  const [argument] = expression.arguments;
  return argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : null;
}

/**
 * Checks whether an expression is the `module.exports` member access.
 *
 * @param expression - Expression to inspect.
 * @returns `true` for `module.exports`.
 */
function isModuleExports(expression: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'module' &&
    expression.name.text === 'exports'
  );
}

/**
 * Classifies the left-hand side of a CommonJS export assignment.
 *
 * @param target - Left-hand side of an `=` assignment.
 * @returns `module` for `module.exports = …`, `named` for `exports.a = …` or
 *   `module.exports.a = …`, or `null` for any other assignment.
 */
function getCommonJsExportTarget(target: ts.Expression): CommonJsExportTarget | null {
  if (isModuleExports(target)) {
    return { kind: 'module' };
  }
  if (!ts.isPropertyAccessExpression(target) || !ts.isIdentifier(target.name)) {
    return null;
  }
  const owner = target.expression;
  const isExportsObject = ts.isIdentifier(owner) && owner.text === 'exports';
  return isExportsObject || isModuleExports(owner)
    ? { kind: 'named', name: target.name.text }
    : null;
}

/**
 * Returns the CommonJS export assignment held by a statement, if any.
 *
 * @param statement - Top-level statement.
 * @returns The export target and assigned value, or `null`.
 */
function getCommonJsAssignment(
  statement: ts.Statement,
): { readonly target: CommonJsExportTarget; readonly value: ts.Expression } | null {
  if (
    !ts.isExpressionStatement(statement) ||
    !ts.isBinaryExpression(statement.expression) ||
    statement.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken
  ) {
    return null;
  }
  const target = getCommonJsExportTarget(statement.expression.left);
  return target === null ? null : { target, value: unwrapExpression(statement.expression.right) };
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

/**
 * Collects every top-level module dependency of a file.
 *
 * @param sourceFile - Parsed file.
 * @returns Imports, re-exports and `require` calls in source order.
 */
function collectImports(sourceFile: ts.SourceFile): ParsedImport[] {
  const imports: ParsedImport[] = [];
  for (const statement of sourceFile.statements) {
    imports.push(...getImportsFromStatement(statement, sourceFile));
  }
  return imports;
}

/**
 * Extracts the imports declared by a single top-level statement.
 *
 * @param statement - Top-level statement.
 * @param sourceFile - File that contains the statement.
 * @returns Zero or more imports declared by the statement.
 */
function getImportsFromStatement(
  statement: ts.Statement,
  sourceFile: ts.SourceFile,
): ParsedImport[] {
  const line = getStartLine(statement, sourceFile);

  if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
    const bindings = getImportClauseBindings(statement.importClause);
    return [{ specifier: statement.moduleSpecifier.text, syntax: 'import', line, bindings }];
  }

  if (
    ts.isExportDeclaration(statement) &&
    statement.moduleSpecifier !== undefined &&
    ts.isStringLiteral(statement.moduleSpecifier)
  ) {
    return [{ specifier: statement.moduleSpecifier.text, syntax: 're-export', line, bindings: [] }];
  }

  if (
    ts.isImportEqualsDeclaration(statement) &&
    ts.isExternalModuleReference(statement.moduleReference) &&
    ts.isStringLiteral(statement.moduleReference.expression)
  ) {
    const bindings: ImportBinding[] = [
      { kind: 'namespace', importedName: '*', localName: statement.name.text },
    ];
    return [
      { specifier: statement.moduleReference.expression.text, syntax: 'require', line, bindings },
    ];
  }

  if (ts.isVariableStatement(statement)) {
    return getRequireImports(statement.declarationList, line);
  }

  if (ts.isExpressionStatement(statement)) {
    const specifier = getRequireSpecifier(unwrapExpression(statement.expression));
    return specifier === null ? [] : [{ specifier, syntax: 'require', line, bindings: [] }];
  }

  return [];
}

/**
 * Converts an ES import clause into local bindings.
 *
 * @param clause - Import clause, absent for side-effect imports.
 * @returns Default, namespace and named bindings declared by the clause.
 */
function getImportClauseBindings(clause: ts.ImportClause | undefined): ImportBinding[] {
  if (clause === undefined) {
    return [];
  }
  const bindings: ImportBinding[] = [];
  if (clause.name !== undefined) {
    bindings.push({
      kind: 'default',
      importedName: DEFAULT_EXPORT_NAME,
      localName: clause.name.text,
    });
  }
  const named = clause.namedBindings;
  if (named !== undefined && ts.isNamespaceImport(named)) {
    bindings.push({ kind: 'namespace', importedName: '*', localName: named.name.text });
  }
  if (named !== undefined && ts.isNamedImports(named)) {
    for (const element of named.elements) {
      bindings.push({
        kind: 'named',
        importedName: (element.propertyName ?? element.name).text,
        localName: element.name.text,
      });
    }
  }
  return bindings;
}

/**
 * Extracts `require` imports from a variable declaration list
 * (`const x = require('./x')`, `const { a } = require('./x')`).
 *
 * @param declarationList - Declarations of a variable statement.
 * @param line - 1-based line of the statement.
 * @returns One import per declaration initialized with `require`.
 */
function getRequireImports(
  declarationList: ts.VariableDeclarationList,
  line: number,
): ParsedImport[] {
  const imports: ParsedImport[] = [];
  for (const declaration of declarationList.declarations) {
    if (declaration.initializer === undefined) {
      continue;
    }
    const specifier = getRequireSpecifier(unwrapExpression(declaration.initializer));
    if (specifier !== null) {
      imports.push({
        specifier,
        syntax: 'require',
        line,
        bindings: getRequireBindings(declaration.name),
      });
    }
  }
  return imports;
}

/**
 * Converts the target of a `require` assignment into local bindings.
 *
 * @param name - Identifier or object destructuring pattern.
 * @returns A namespace binding for identifiers, named bindings for patterns.
 */
function getRequireBindings(name: ts.BindingName): ImportBinding[] {
  if (ts.isIdentifier(name)) {
    return [{ kind: 'namespace', importedName: '*', localName: name.text }];
  }
  if (!ts.isObjectBindingPattern(name)) {
    return [];
  }
  const bindings: ImportBinding[] = [];
  for (const element of name.elements) {
    if (element.dotDotDotToken !== undefined || !ts.isIdentifier(element.name)) {
      continue;
    }
    const importedName =
      element.propertyName === undefined
        ? element.name.text
        : getPropertyNameText(element.propertyName);
    if (importedName !== null) {
      bindings.push({ kind: 'named', importedName, localName: element.name.text });
    }
  }
  return bindings;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Collects every name a file exposes to importers (ES and CommonJS).
 *
 * @param sourceFile - Parsed file.
 * @returns Export entries mapping exported names to local declarations.
 */
function collectExports(sourceFile: ts.SourceFile): ParsedExport[] {
  const exports: ParsedExport[] = [];
  for (const statement of sourceFile.statements) {
    exports.push(...getExportsFromStatement(statement));
  }
  return exports;
}

/**
 * Extracts the exports declared by a single top-level statement.
 *
 * @param statement - Top-level statement.
 * @returns Zero or more export entries.
 */
function getExportsFromStatement(statement: ts.Statement): ParsedExport[] {
  if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      return [];
    }
    const localName = statement.name?.text ?? DEFAULT_EXPORT_NAME;
    const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
    return [{ exportedName: isDefault ? DEFAULT_EXPORT_NAME : localName, localName }];
  }

  if (ts.isVariableStatement(statement)) {
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      return [];
    }
    return statement.declarationList.declarations
      .filter((declaration) => ts.isIdentifier(declaration.name))
      .map((declaration) => {
        const name = (declaration.name as ts.Identifier).text;
        return { exportedName: name, localName: name };
      });
  }

  if (
    ts.isExportDeclaration(statement) &&
    statement.moduleSpecifier === undefined &&
    !statement.isTypeOnly &&
    statement.exportClause !== undefined &&
    ts.isNamedExports(statement.exportClause)
  ) {
    return statement.exportClause.elements
      .filter((element) => !element.isTypeOnly)
      .map((element) => ({
        exportedName: element.name.text,
        localName: (element.propertyName ?? element.name).text,
      }));
  }

  if (ts.isExportAssignment(statement)) {
    return getDefaultValueExports(unwrapExpression(statement.expression));
  }

  const assignment = getCommonJsAssignment(statement);
  if (assignment !== null) {
    return getCommonJsExports(assignment.target, assignment.value);
  }

  return [];
}

/**
 * Builds the export entry for a value exported as default
 * (`export default x`, `export = x`, `module.exports = x`).
 *
 * @param value - Exported expression (already unwrapped).
 * @returns The default export entry, or nothing if the value is not a name or function.
 */
function getDefaultValueExports(value: ts.Expression): ParsedExport[] {
  if (ts.isIdentifier(value)) {
    return [{ exportedName: DEFAULT_EXPORT_NAME, localName: value.text }];
  }
  if (isFunctionExpressionLike(value)) {
    return [{ exportedName: DEFAULT_EXPORT_NAME, localName: DEFAULT_EXPORT_NAME }];
  }
  return [];
}

/**
 * Builds export entries for a CommonJS export assignment.
 *
 * @param target - Classified left-hand side of the assignment.
 * @param value - Assigned expression (already unwrapped).
 * @returns Export entries described by the assignment.
 */
function getCommonJsExports(target: CommonJsExportTarget, value: ts.Expression): ParsedExport[] {
  if (target.kind === 'named') {
    if (ts.isIdentifier(value)) {
      return [{ exportedName: target.name, localName: value.text }];
    }
    return isFunctionExpressionLike(value)
      ? [{ exportedName: target.name, localName: target.name }]
      : [];
  }
  if (ts.isObjectLiteralExpression(value)) {
    return getObjectLiteralExports(value);
  }
  return getDefaultValueExports(value);
}

/**
 * Builds export entries for `module.exports = { … }`.
 *
 * @param literal - Object literal assigned to `module.exports`.
 * @returns One entry per property backed by a name or a function.
 */
function getObjectLiteralExports(literal: ts.ObjectLiteralExpression): ParsedExport[] {
  const exports: ParsedExport[] = [];
  for (const property of literal.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      exports.push({ exportedName: property.name.text, localName: property.name.text });
      continue;
    }
    const name =
      ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)
        ? getPropertyNameText(property.name)
        : null;
    if (name === null) {
      continue;
    }
    if (ts.isMethodDeclaration(property)) {
      exports.push({ exportedName: name, localName: name });
      continue;
    }
    const initializer = unwrapExpression((property as ts.PropertyAssignment).initializer);
    if (ts.isIdentifier(initializer)) {
      exports.push({ exportedName: name, localName: initializer.text });
    } else if (isFunctionExpressionLike(initializer)) {
      exports.push({ exportedName: name, localName: name });
    }
  }
  return exports;
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Collects every top-level function, function-valued variable, class member
 * and CommonJS-exported function of a file.
 *
 * @param sourceFile - Parsed file.
 * @param exportedLocalNames - Local names backed by an export entry.
 * @returns Parsed functions in source order.
 */
function collectFunctions(
  sourceFile: ts.SourceFile,
  exportedLocalNames: ReadonlySet<string>,
): ParsedFunction[] {
  const descriptors: FunctionDescriptor[] = [];
  for (const statement of sourceFile.statements) {
    descriptors.push(...getFunctionDescriptors(statement, exportedLocalNames));
  }
  return descriptors.map((descriptor) => buildParsedFunction(descriptor, sourceFile));
}

/**
 * Describes the functions declared by a single top-level statement.
 *
 * @param statement - Top-level statement.
 * @param exportedLocalNames - Local names backed by an export entry.
 * @returns Zero or more function descriptors.
 */
function getFunctionDescriptors(
  statement: ts.Statement,
  exportedLocalNames: ReadonlySet<string>,
): FunctionDescriptor[] {
  if (ts.isFunctionDeclaration(statement)) {
    if (statement.body === undefined) {
      return []; // Overload signature or `declare function`.
    }
    const name = statement.name?.text ?? DEFAULT_EXPORT_NAME;
    return [
      {
        name,
        functionKind: 'function',
        declaration: statement,
        body: statement.body,
        exported: exportedLocalNames.has(name),
      },
    ];
  }

  if (ts.isVariableStatement(statement)) {
    return getVariableFunctionDescriptors(statement, exportedLocalNames);
  }

  if (ts.isClassDeclaration(statement)) {
    const className = statement.name?.text ?? DEFAULT_EXPORT_NAME;
    return getClassMemberDescriptors(statement, className, exportedLocalNames.has(className));
  }

  if (ts.isExportAssignment(statement)) {
    const value = unwrapExpression(statement.expression);
    return isFunctionExpressionLike(value)
      ? [createExpressionDescriptor(DEFAULT_EXPORT_NAME, statement, value, true)]
      : [];
  }

  const assignment = getCommonJsAssignment(statement);
  if (assignment !== null) {
    return getCommonJsFunctionDescriptors(statement, assignment.target, assignment.value);
  }

  return [];
}

/**
 * Describes functions assigned to variables (`const foo = () => {}`).
 *
 * @param statement - Variable statement.
 * @param exportedLocalNames - Local names backed by an export entry.
 * @returns One descriptor per declaration initialized with a function.
 */
function getVariableFunctionDescriptors(
  statement: ts.VariableStatement,
  exportedLocalNames: ReadonlySet<string>,
): FunctionDescriptor[] {
  const descriptors: FunctionDescriptor[] = [];
  for (const declaration of statement.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) {
      continue;
    }
    const value = unwrapExpression(declaration.initializer);
    if (isFunctionExpressionLike(value)) {
      const name = declaration.name.text;
      descriptors.push(
        createExpressionDescriptor(name, statement, value, exportedLocalNames.has(name)),
      );
    }
  }
  return descriptors;
}

/**
 * Describes the methods, constructor and function-valued properties of a class.
 *
 * @param declaration - Class declaration.
 * @param className - Class name (`default` for anonymous default exports).
 * @param exported - Whether the class is exported.
 * @returns One descriptor per member with a body.
 */
function getClassMemberDescriptors(
  declaration: ts.ClassDeclaration,
  className: string,
  exported: boolean,
): FunctionDescriptor[] {
  const descriptors: FunctionDescriptor[] = [];
  for (const member of declaration.members) {
    const descriptor = getClassMemberDescriptor(member, className, exported);
    if (descriptor !== null) {
      descriptors.push(descriptor);
    }
  }
  return descriptors;
}

/**
 * Describes a single class member if it is function-like and has a body.
 *
 * @param member - Class member.
 * @param className - Enclosing class name.
 * @param exported - Whether the class is exported.
 * @returns A descriptor, or `null` for fields, accessors, signatures and computed names.
 */
function getClassMemberDescriptor(
  member: ts.ClassElement,
  className: string,
  exported: boolean,
): FunctionDescriptor | null {
  if (ts.isConstructorDeclaration(member) && member.body !== undefined) {
    return createMethodDescriptor('constructor', className, member, member.body, exported);
  }
  if (ts.isMethodDeclaration(member) && member.body !== undefined) {
    const name = getPropertyNameText(member.name);
    return name === null
      ? null
      : createMethodDescriptor(name, className, member, member.body, exported);
  }
  if (ts.isPropertyDeclaration(member) && member.initializer !== undefined) {
    const value = unwrapExpression(member.initializer);
    const name = getPropertyNameText(member.name);
    return name !== null && isFunctionExpressionLike(value)
      ? createMethodDescriptor(name, className, member, value, exported)
      : null;
  }
  return null;
}

/**
 * Describes functions created by CommonJS export assignments
 * (`exports.a = () => {}`, `module.exports = function () {}`,
 * `module.exports = { a() {}, b: () => {} }`).
 *
 * @param statement - Assignment statement.
 * @param target - Classified export target.
 * @param value - Assigned expression (already unwrapped).
 * @returns Descriptors for every function defined inline by the assignment.
 */
function getCommonJsFunctionDescriptors(
  statement: ts.Statement,
  target: CommonJsExportTarget,
  value: ts.Expression,
): FunctionDescriptor[] {
  if (isFunctionExpressionLike(value)) {
    const name = target.kind === 'named' ? target.name : DEFAULT_EXPORT_NAME;
    return [createExpressionDescriptor(name, statement, value, true)];
  }
  if (target.kind === 'module' && ts.isObjectLiteralExpression(value)) {
    return getObjectLiteralFunctionDescriptors(value);
  }
  return [];
}

/**
 * Describes functions defined inline in `module.exports = { … }`.
 *
 * @param literal - Object literal assigned to `module.exports`.
 * @returns One descriptor per method or function-valued property.
 */
function getObjectLiteralFunctionDescriptors(
  literal: ts.ObjectLiteralExpression,
): FunctionDescriptor[] {
  const descriptors: FunctionDescriptor[] = [];
  for (const property of literal.properties) {
    if (ts.isMethodDeclaration(property) && property.body !== undefined) {
      const name = getPropertyNameText(property.name);
      if (name !== null) {
        descriptors.push({
          name,
          functionKind: 'function',
          declaration: property,
          body: property.body,
          exported: true,
        });
      }
    } else if (ts.isPropertyAssignment(property)) {
      const value = unwrapExpression(property.initializer);
      const name = getPropertyNameText(property.name);
      if (name !== null && isFunctionExpressionLike(value)) {
        descriptors.push(createExpressionDescriptor(name, property, value, true));
      }
    }
  }
  return descriptors;
}

/**
 * Creates a descriptor for a function defined by an expression.
 *
 * @param name - Function name.
 * @param declaration - Node that defines the reported start line.
 * @param value - Arrow function or function expression.
 * @param exported - Whether the function is exported.
 * @returns The function descriptor.
 */
function createExpressionDescriptor(
  name: string,
  declaration: ts.Node,
  value: FunctionExpressionLike,
  exported: boolean,
): FunctionDescriptor {
  return {
    name,
    functionKind: getExpressionFunctionKind(value),
    declaration,
    body: value,
    exported,
  };
}

/**
 * Creates a descriptor for a class member.
 *
 * @param name - Member name.
 * @param className - Enclosing class name.
 * @param declaration - Member node (defines the reported start line).
 * @param body - Member body (scanned for calls).
 * @param exported - Whether the class is exported.
 * @returns The function descriptor.
 */
function createMethodDescriptor(
  name: string,
  className: string,
  declaration: ts.Node,
  body: ts.Node,
  exported: boolean,
): FunctionDescriptor {
  return { name, className, functionKind: 'method', declaration, body, exported };
}

/**
 * Converts a descriptor into the final parsed function, including its calls.
 *
 * @param descriptor - Function descriptor.
 * @param sourceFile - File that contains the function.
 * @returns The parsed function.
 */
function buildParsedFunction(
  descriptor: FunctionDescriptor,
  sourceFile: ts.SourceFile,
): ParsedFunction {
  const { name, className, functionKind, declaration, body, exported } = descriptor;
  return {
    name,
    qualifiedName: className === undefined ? name : `${className}.${name}`,
    ...(className === undefined ? {} : { className }),
    functionKind,
    line: getStartLine(declaration, sourceFile),
    endLine: getEndLine(body, sourceFile),
    exported,
    calls: collectCalls(body, sourceFile),
  };
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/**
 * Collects the call sites inside a function body, including nested closures.
 *
 * @param body - Function body (or expression body of an arrow function).
 * @param sourceFile - File that contains the body.
 * @returns Recognized calls in source order.
 */
function collectCalls(body: ts.Node, sourceFile: ts.SourceFile): ParsedCall[] {
  const calls: ParsedCall[] = [];
  visitCalls(body, sourceFile, calls);
  return calls;
}

/**
 * Depth-first walk that appends every recognized call to `calls`.
 *
 * @param node - Current node.
 * @param sourceFile - File that contains the node.
 * @param calls - Accumulator mutated in place.
 */
function visitCalls(node: ts.Node, sourceFile: ts.SourceFile, calls: ParsedCall[]): void {
  if (ts.isCallExpression(node)) {
    const call = toParsedCall(node, sourceFile);
    if (call !== null) {
      calls.push(call);
    }
  }
  ts.forEachChild(node, (child) => {
    visitCalls(child, sourceFile, calls);
  });
}

/**
 * Classifies a call expression.
 *
 * @param call - Call expression.
 * @param sourceFile - File that contains the call.
 * @returns The parsed call, or `null` for shapes the linker cannot resolve
 *   (e.g. `a.b.c()`, `fn()()`, `require()`).
 */
function toParsedCall(call: ts.CallExpression, sourceFile: ts.SourceFile): ParsedCall | null {
  const line = getStartLine(call, sourceFile);
  const callee = unwrapExpression(call.expression);

  if (ts.isIdentifier(callee)) {
    return callee.text === REQUIRE_IDENTIFIER
      ? null
      : { kind: 'identifier', name: callee.text, line };
  }

  if (ts.isPropertyAccessExpression(callee)) {
    const name = callee.name.text;
    const receiver = unwrapExpression(callee.expression);
    if (receiver.kind === ts.SyntaxKind.ThisKeyword) {
      return { kind: 'this-member', name, line };
    }
    if (ts.isIdentifier(receiver)) {
      return { kind: 'member', name, receiver: receiver.text, line };
    }
  }

  return null;
}
