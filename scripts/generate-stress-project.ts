/**
 * CLI: writes a synthetic stress project to the OS temp folder.
 *
 * Usage: npm run stress:generate -- --size L [--seed 42]
 */
import { generateProject } from './lib/generateProject';
import { stressProjectDir, writeProject } from './lib/readers';
import { STRESS_SIZES, parseSizes, readFlag } from './lib/sizes';
import { formatCount, formatMs } from './lib/stats';

/** Generates and writes the requested projects. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const seed = Number(readFlag(args, 'seed') ?? 42);
  for (const size of parseSizes(readFlag(args, 'size'), ['S'])) {
    const startedAt = performance.now();
    const project = generateProject({ files: size.files, seed });
    const folder = stressProjectDir(size.id);
    await writeProject(project.files, folder);
    console.log(
      `${size.id} (${STRESS_SIZES[size.id].description}): ${formatCount(project.files.size)} files, ` +
        `${formatCount(project.functionCount)} functions → ${folder} (${formatMs(performance.now() - startedAt)})`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
