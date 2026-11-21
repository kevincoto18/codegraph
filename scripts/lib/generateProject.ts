/**
 * Deterministic generator of realistic synthetic TS/JS projects for stress tests.
 *
 * Generated projects mix `.ts`, `.tsx`, ES `.js` and CommonJS `.js` files with
 * function declarations, arrow functions, classes, aliased/namespace imports,
 * `require`, barrels, deep folders and a few "hub" files imported by a large
 * share of the project (worst case for re-linking).
 */
import { posix } from 'node:path';

import type { Random } from './random';
import { createRandom, pick, randomInt, sample } from './random';

/** Options of {@link generateProject}. */
export interface GenerateOptions {
  /** Total number of source files (hubs and barrels included). */
  readonly files: number;
  /** PRNG seed; the same seed always yields the same project. */
  readonly seed?: number;
}

/** A generated project, kept in memory. */
export interface GeneratedProject {
  /** File contents by workspace-relative POSIX path. */
  readonly files: Map<string, string>;
  /** Paths of the hub files. */
  readonly hubFiles: readonly string[];
  /** Root folders of the packages (e.g. `packages/pkg0`). */
  readonly packageRoots: readonly string[];
  /** Number of generated functions (declarations, arrows and methods). */
  readonly functionCount: number;
}

/** Syntax flavour of a generated file. */
type FileKind = 'ts' | 'tsx' | 'esm' | 'cjs';

/** What other files can import from an already generated file. */
interface ModuleInfo {
  readonly path: string;
  readonly kind: FileKind;
  /** Exported top-level function names. */
  readonly functions: readonly string[];
}

/** A local name the current file can call, and how to call it. */
interface Callable {
  /** Call expression without arguments, e.g. `fn`, `ns.fn`. */
  readonly expression: string;
}

/** Number of hub files. */
const HUB_COUNT = 5;

/** Functions exported by each hub. */
const HUB_FUNCTIONS = 12;

/** Approximate number of files per package. */
const FILES_PER_PACKAGE = 250;

/** Share of files that import a hub. */
const HUB_IMPORT_RATIO = 0.5;

/** Share of imports that target the same package. */
const SAME_PACKAGE_RATIO = 0.75;

/**
 * Chooses the syntax flavour of a file.
 *
 * @param random - Generator.
 * @returns The file kind (65% TS, 10% TSX, 13% ES JS, 12% CommonJS).
 */
function chooseKind(random: Random): FileKind {
  const roll = random();
  if (roll < 0.65) {
    return 'ts';
  }
  if (roll < 0.75) {
    return 'tsx';
  }
  return roll < 0.88 ? 'esm' : 'cjs';
}

/**
 * Returns the file extension of a kind.
 *
 * @param kind - File kind.
 * @returns The extension including the dot.
 */
function extensionOf(kind: FileKind): string {
  switch (kind) {
    case 'ts':
      return '.ts';
    case 'tsx':
      return '.tsx';
    case 'esm':
    case 'cjs':
      return '.js';
  }
}

/**
 * Computes the relative module specifier from one file to another (no extension).
 *
 * @param fromPath - Importing file.
 * @param toPath - Imported file.
 * @returns E.g. `./util` or `../../shared/hub0`.
 */
export function relativeSpecifier(fromPath: string, toPath: string): string {
  const withoutExtension = toPath.slice(0, toPath.length - posix.extname(toPath).length);
  const relative = posix.relative(posix.dirname(fromPath), withoutExtension);
  return relative.startsWith('.') ? relative : `./${relative}`;
}

/**
 * Generates a hub file exporting many functions.
 *
 * @param index - Hub index.
 * @returns The hub path, content and exported names.
 */
function generateHub(index: number): { path: string; content: string; functions: string[] } {
  const functions = Array.from(
    { length: HUB_FUNCTIONS },
    (_, k) => `hub${String(index)}Fn${String(k)}`,
  );
  const lines = functions.map(
    (name, k) =>
      `export function ${name}(value: number): number {\n  return ${k > 0 ? `${functions[k - 1] ?? name}(value) + ` : ''}value;\n}\n`,
  );
  return { path: `shared/hub${String(index)}.ts`, content: lines.join('\n'), functions };
}

/**
 * Generates the import section of a file and the names it can call.
 *
 * @param random - Generator.
 * @param path - Path of the file being generated.
 * @param kind - Its syntax flavour.
 * @param targets - Modules to import.
 * @returns Import lines and callable expressions.
 */
function generateImports(
  random: Random,
  path: string,
  kind: FileKind,
  targets: readonly ModuleInfo[],
): { lines: string[]; callables: Callable[] } {
  const lines: string[] = [];
  const callables: Callable[] = [];
  targets.forEach((target, index) => {
    if (target.functions.length === 0) {
      return;
    }
    const specifier = relativeSpecifier(path, target.path);
    const useNamespace = random() < 0.2;
    if (useNamespace) {
      const namespace = `mod${String(index)}`;
      lines.push(
        kind === 'cjs'
          ? `const ${namespace} = require('${specifier}');`
          : `import * as ${namespace} from '${specifier}';`,
      );
      for (const name of sample(random, target.functions, 2)) {
        callables.push({ expression: `${namespace}.${name}` });
      }
      return;
    }
    const names = sample(random, target.functions, randomInt(random, 1, 3));
    const bindings = names.map((name, k) =>
      k === 0 && random() < 0.3 ? { name, alias: `${name}Alias` } : { name, alias: name },
    );
    if (kind === 'cjs') {
      const parts = bindings.map(({ name, alias }) =>
        alias === name ? name : `${name}: ${alias}`,
      );
      lines.push(`const { ${parts.join(', ')} } = require('${specifier}');`);
    } else {
      const parts = bindings.map(({ name, alias }) =>
        alias === name ? name : `${name} as ${alias}`,
      );
      lines.push(`import { ${parts.join(', ')} } from '${specifier}';`);
    }
    for (const { alias } of bindings) {
      callables.push({ expression: alias });
    }
  });
  return { lines, callables };
}

/**
 * Builds the body of a function: a few calls to available callables.
 *
 * @param random - Generator.
 * @param callables - Calls the function may make.
 * @returns Body lines (indented).
 */
function generateBody(random: Random, callables: readonly Callable[]): string[] {
  const calls = callables.length === 0 ? [] : sample(random, callables, randomInt(random, 1, 3));
  return [
    '  let total = 0;',
    ...calls.map((callable) => `  total += Number(${callable.expression}(total));`),
    '  return total;',
  ];
}

/**
 * Generates one regular source file.
 *
 * @param random - Generator.
 * @param path - File path.
 * @param kind - Syntax flavour.
 * @param fileIndex - Global file index (keeps names unique).
 * @param imports - Modules this file imports.
 * @returns The content, exported functions and number of functions.
 */
function generateSourceFile(
  random: Random,
  path: string,
  kind: FileKind,
  fileIndex: number,
  imports: readonly ModuleInfo[],
): { content: string; exported: string[]; functionCount: number } {
  const typed = kind === 'ts' || kind === 'tsx';
  const { lines: importLines, callables } = generateImports(random, path, kind, imports);
  const big = random() < 0.1;
  const functionTotal = big ? randomInt(random, 20, 35) : randomInt(random, 5, 10);
  const prefix = `f${String(fileIndex)}_`;
  const exported: string[] = [];
  const body: string[] = [];
  const localCallables: Callable[] = [...callables];
  const param = typed ? 'input: number' : 'input';
  const returnType = typed ? ': number' : '';

  for (let k = 0; k < functionTotal; k += 1) {
    const name = `${prefix}${String(k)}`;
    const lines = generateBody(random, localCallables);
    const isExported = random() < 0.7;
    const exportKeyword = isExported && kind !== 'cjs' ? 'export ' : '';
    if (random() < 0.35) {
      body.push(`${exportKeyword}const ${name} = (${param})${returnType} => {`, ...lines, '};', '');
    } else {
      body.push(`${exportKeyword}function ${name}(${param})${returnType} {`, ...lines, '}', '');
    }
    if (isExported) {
      exported.push(name);
    }
    localCallables.push({ expression: name });
  }

  let methodCount = 0;
  if (random() < 0.4) {
    const className = `Service${String(fileIndex)}`;
    methodCount = randomInt(random, 2, 4);
    const methods: string[] = [];
    for (let m = 0; m < methodCount; m += 1) {
      const calls = generateBody(random, [
        ...sample(random, localCallables, 1),
        ...(m > 0 ? [{ expression: `this.method${String(m - 1)}` }] : []),
      ]);
      methods.push(
        `  method${String(m)}(${param})${returnType} {`,
        ...calls.map((line) => `  ${line}`),
        '  }',
      );
    }
    const exportKeyword = kind === 'cjs' ? '' : 'export ';
    body.push(`${exportKeyword}class ${className} {`, ...methods, '}', '');
  }

  if (kind === 'tsx') {
    const view = `View${String(fileIndex)}`;
    const target = pick(random, localCallables);
    body.push(
      `export function ${view}(props: { value: number }) {`,
      `  return <div onClick={() => ${target.expression}(props.value)}>{props.value}</div>;`,
      '}',
      '',
    );
    exported.push(view);
  }

  if (kind === 'cjs') {
    body.push(`module.exports = { ${exported.join(', ')} };`, '');
  }

  const extraFunctions = (kind === 'tsx' ? 1 : 0) + methodCount;
  return {
    content: [...importLines, '', ...body].join('\n'),
    exported,
    functionCount: functionTotal + extraFunctions,
  };
}

/**
 * Generates a synthetic project.
 *
 * @param options - Size and seed.
 * @returns The project, in memory.
 */
export function generateProject(options: GenerateOptions): GeneratedProject {
  const random = createRandom(options.seed ?? 42);
  const files = new Map<string, string>();
  const modules: ModuleInfo[] = [];
  const modulesByPackage = new Map<number, ModuleInfo[]>();
  let functionCount = 0;

  const hubs = Array.from({ length: HUB_COUNT }, (_, index) => generateHub(index));
  for (const hub of hubs) {
    files.set(hub.path, hub.content);
    functionCount += hub.functions.length;
  }
  const hubModules: ModuleInfo[] = hubs.map((hub) => ({
    path: hub.path,
    kind: 'ts',
    functions: hub.functions,
  }));

  const packageCount = Math.max(1, Math.ceil(options.files / FILES_PER_PACKAGE));
  const packageRoots = Array.from({ length: packageCount }, (_, p) => `packages/pkg${String(p)}`);
  const sourceFileCount = Math.max(0, options.files - HUB_COUNT - packageCount);

  for (let index = 0; index < sourceFileCount; index += 1) {
    const packageIndex = index % packageCount;
    const depth = randomInt(random, 0, 3);
    const folders = Array.from(
      { length: depth },
      (_, level) => `area${String(randomInt(random, 0, 4))}_${String(level)}`,
    );
    const kind = chooseKind(random);
    const path = posix.join(
      packageRoots[packageIndex] ?? 'packages/pkg0',
      'src',
      ...folders,
      `file${String(index)}${extensionOf(kind)}`,
    );

    const samePackage = modulesByPackage.get(packageIndex) ?? [];
    const pool = random() < SAME_PACKAGE_RATIO && samePackage.length > 0 ? samePackage : modules;
    const targets = pool.length === 0 ? [] : sample(random, pool, randomInt(random, 1, 4));
    if (random() < HUB_IMPORT_RATIO) {
      targets.push(pick(random, hubModules));
    }

    const generated = generateSourceFile(random, path, kind, index, targets);
    files.set(path, generated.content);
    functionCount += generated.functionCount;

    const info: ModuleInfo = { path, kind, functions: generated.exported };
    modules.push(info);
    modulesByPackage.set(packageIndex, [...samePackage, info]);
  }

  // One barrel per package re-exporting a few modules (file edges only).
  packageRoots.forEach((root, packageIndex) => {
    const barrelPath = `${root}/src/index.ts`;
    const members = (modulesByPackage.get(packageIndex) ?? [])
      .filter((module) => module.kind !== 'cjs')
      .slice(0, 10);
    const lines = members.map(
      (module) => `export * from '${relativeSpecifier(barrelPath, module.path)}';`,
    );
    files.set(barrelPath, lines.join('\n') + '\n');
  });

  return { files, hubFiles: hubs.map((hub) => hub.path), packageRoots, functionCount };
}
