/**
 * Integration tests: analyzes the Java, C# and Go sample projects through the
 * graph service (grammar loading, parsers, symbol table and linker) and
 * checks the complete expected graphs.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { GraphSnapshot, RelPath } from '../shared';
import { toPosixPath } from '../shared';
import { GraphService } from './graphService';

/** Logger that ignores everything. */
const silent = {
  /** Ignores the message. */
  info: (): void => undefined,
  /** Ignores the message. */
  warn: (): void => undefined,
  /** Ignores the message. */
  error: (): void => undefined,
};

/** Expected graph of one sample project. */
interface DemoCase {
  readonly name: string;
  readonly folder: string;
  readonly description: string;
  /** `file id (function count)`, in graph order. */
  readonly files: readonly string[];
  /** `caller -> callee`, sorted. */
  readonly calls: readonly string[];
  /** `importer -> imported`, sorted. */
  readonly imports: readonly string[];
}

const DEMOS: readonly DemoCase[] = [
  {
    name: 'Java',
    folder: 'java-demo',
    description:
      'resolves packages, single-type and wildcard imports, field types, inheritance and constructors',
    files: [
      'src/main/java/com/demo/App.java (2)',
      'src/main/java/com/demo/model/User.java (2)',
      'src/main/java/com/demo/repository/BaseRepository.java (2)',
      'src/main/java/com/demo/repository/Repository.java (2)',
      'src/main/java/com/demo/repository/UserRepository.java (3)',
      'src/main/java/com/demo/service/UserService.java (3)',
      'src/main/java/com/demo/util/Logger.java (3)',
    ],
    calls: [
      'src/main/java/com/demo/App.java#App.main -> src/main/java/com/demo/App.java#App.printUser',
      'src/main/java/com/demo/App.java#App.main -> src/main/java/com/demo/model/User.java#User.constructor',
      'src/main/java/com/demo/App.java#App.main -> src/main/java/com/demo/service/UserService.java#UserService.constructor',
      'src/main/java/com/demo/App.java#App.main -> src/main/java/com/demo/service/UserService.java#UserService.register',
      'src/main/java/com/demo/App.java#App.main -> src/main/java/com/demo/util/Logger.java#Logger.info',
      'src/main/java/com/demo/App.java#App.printUser -> src/main/java/com/demo/model/User.java#User.getName',
      'src/main/java/com/demo/App.java#App.printUser -> src/main/java/com/demo/util/Logger.java#Logger.info',
      'src/main/java/com/demo/repository/BaseRepository.java#BaseRepository.flush -> src/main/java/com/demo/repository/BaseRepository.java#BaseRepository.log',
      'src/main/java/com/demo/repository/BaseRepository.java#BaseRepository.log -> src/main/java/com/demo/util/Logger.java#Logger.info',
      'src/main/java/com/demo/repository/UserRepository.java#UserRepository.save -> src/main/java/com/demo/model/User.java#User.getName',
      'src/main/java/com/demo/repository/UserRepository.java#UserRepository.save -> src/main/java/com/demo/repository/BaseRepository.java#BaseRepository.log',
      'src/main/java/com/demo/repository/UserRepository.java#UserRepository.save -> src/main/java/com/demo/repository/UserRepository.java#UserRepository.validate',
      'src/main/java/com/demo/repository/UserRepository.java#UserRepository.validate -> src/main/java/com/demo/model/User.java#User.getName',
      'src/main/java/com/demo/service/UserService.java#UserService.notify -> src/main/java/com/demo/model/User.java#User.getName',
      'src/main/java/com/demo/service/UserService.java#UserService.notify -> src/main/java/com/demo/util/Logger.java#Logger.info',
      'src/main/java/com/demo/service/UserService.java#UserService.register -> src/main/java/com/demo/model/User.java#User.constructor',
      'src/main/java/com/demo/service/UserService.java#UserService.register -> src/main/java/com/demo/repository/BaseRepository.java#BaseRepository.flush',
      'src/main/java/com/demo/service/UserService.java#UserService.register -> src/main/java/com/demo/repository/UserRepository.java#UserRepository.save',
      'src/main/java/com/demo/service/UserService.java#UserService.register -> src/main/java/com/demo/service/UserService.java#UserService.notify',
      'src/main/java/com/demo/util/Logger.java#Logger.info -> src/main/java/com/demo/util/Logger.java#Logger.write',
    ],
    imports: [
      'src/main/java/com/demo/App.java -> src/main/java/com/demo/model/User.java',
      'src/main/java/com/demo/App.java -> src/main/java/com/demo/repository/UserRepository.java',
      'src/main/java/com/demo/App.java -> src/main/java/com/demo/service/UserService.java',
      'src/main/java/com/demo/App.java -> src/main/java/com/demo/util/Logger.java',
      'src/main/java/com/demo/repository/BaseRepository.java -> src/main/java/com/demo/util/Logger.java',
      'src/main/java/com/demo/repository/UserRepository.java -> src/main/java/com/demo/model/User.java',
      'src/main/java/com/demo/service/UserService.java -> src/main/java/com/demo/model/User.java',
      'src/main/java/com/demo/service/UserService.java -> src/main/java/com/demo/repository/UserRepository.java',
      'src/main/java/com/demo/service/UserService.java -> src/main/java/com/demo/util/Logger.java',
    ],
  },
  {
    name: 'C#',
    folder: 'csharp-demo',
    description:
      'resolves namespaces, parent namespaces, interfaces, file-scoped namespaces and properties',
    files: [
      'Data/IRepository.cs (1)',
      'Data/UserRepository.cs (3)',
      'Log.cs (2)',
      'Models/User.cs (1)',
      'Program.cs (1)',
      'Services/UserService.cs (3)',
    ],
    calls: [
      'Data/UserRepository.cs#UserRepository.Save -> Data/UserRepository.cs#UserRepository.Validate',
      'Data/UserRepository.cs#UserRepository.Save -> Log.cs#Log.Info',
      'Data/UserRepository.cs#UserRepository.Save -> Models/User.cs#User.Display',
      'Log.cs#Log.Info -> Log.cs#Log.Write',
      'Program.cs#Program.Main -> Log.cs#Log.Info',
      'Program.cs#Program.Main -> Services/UserService.cs#UserService.Register',
      'Program.cs#Program.Main -> Services/UserService.cs#UserService.constructor',
      'Services/UserService.cs#UserService.Notify -> Log.cs#Log.Info',
      'Services/UserService.cs#UserService.Notify -> Models/User.cs#User.Display',
      'Services/UserService.cs#UserService.Register -> Data/IRepository.cs#IRepository.Save',
      'Services/UserService.cs#UserService.Register -> Services/UserService.cs#UserService.Notify',
    ],
    imports: [
      'Data/UserRepository.cs -> Models/User.cs',
      'Program.cs -> Data/UserRepository.cs',
      'Program.cs -> Services/UserService.cs',
      'Services/UserService.cs -> Data/IRepository.cs',
      'Services/UserService.cs -> Models/User.cs',
    ],
  },
  {
    name: 'Go',
    folder: 'go-demo',
    description:
      'resolves packages by folder, aliases, function results, embedded structs and interfaces',
    files: [
      'internal/model/user.go (1)',
      'internal/service/service.go (3)',
      'internal/storage/base.go (1)',
      'internal/storage/repo.go (3)',
      'main.go (1)',
      'run.go (2)',
    ],
    calls: [
      'internal/service/service.go#Service.Register -> internal/service/service.go#Service.notify',
      'internal/service/service.go#Service.Register -> internal/storage/repo.go#Repo.Save',
      'internal/service/service.go#Service.notify -> internal/model/user.go#User.Display',
      'internal/storage/repo.go#MemoryRepo.Save -> internal/model/user.go#User.Display',
      'internal/storage/repo.go#MemoryRepo.Save -> internal/storage/base.go#base.log',
      'main.go#main -> internal/service/service.go#New',
      'main.go#main -> internal/service/service.go#Service.Register',
      'main.go#main -> internal/storage/repo.go#NewMemoryRepo',
      'main.go#main -> run.go#run',
      'run.go#run -> run.go#greeting',
    ],
    imports: [
      'internal/service/service.go -> internal/model/user.go',
      'internal/service/service.go -> internal/storage/repo.go',
      'internal/storage/repo.go -> internal/model/user.go',
      'main.go -> internal/service/service.go',
      'main.go -> internal/storage/repo.go',
    ],
  },
];

/**
 * Analyzes a sample project with the real service.
 *
 * @param folder - Folder under `samples/`.
 * @returns The graph.
 */
async function analyze(folder: string): Promise<GraphSnapshot> {
  const root = fileURLToPath(new URL(`../../samples/${folder}`, import.meta.url));
  const service = new GraphService(
    {
      listFiles: (): Promise<RelPath[]> =>
        Promise.resolve(readdirSync(root, { recursive: true, encoding: 'utf8' }).map(toPosixPath)),
      readFile: (filePath): Promise<string> =>
        Promise.resolve(readFileSync(join(root, filePath), 'utf8')),
    },
    silent,
  );
  return service.initialize();
}

/**
 * Edges of one kind as `source -> target`, sorted.
 *
 * @param graph - Graph.
 * @param kind - Edge kind.
 * @returns The edge descriptions.
 */
function edgesOf(graph: GraphSnapshot, kind: 'call' | 'import'): string[] {
  return graph.edges
    .filter((edge) => edge.kind === kind)
    .map((edge) => `${edge.source} -> ${edge.target}`)
    .sort();
}

describe.each(DEMOS)('$name demo project', (demo) => {
  it(demo.description, async () => {
    const graph = await analyze(demo.folder);
    expect(
      graph.nodes.flatMap((node) =>
        node.kind === 'file' ? [`${node.id} (${String(node.functionIds.length)})`] : [],
      ),
    ).toEqual(demo.files);
    expect(edgesOf(graph, 'call')).toEqual(demo.calls);
    expect(edgesOf(graph, 'import')).toEqual(demo.imports);
  });
});
