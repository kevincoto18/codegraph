/**
 * Entry point of the analyzer bundle (`dist/analysis.js`).
 *
 * @remarks The analyzer embeds the TypeScript compiler (~10 MB of
 * JavaScript). It is built as a separate bundle and loaded with a dynamic
 * `import()` the first time a graph is opened, so VS Code does not even parse
 * it when the extension activates.
 */
export { ANALYSIS_CACHE_KEY, GraphService } from './graphService';
