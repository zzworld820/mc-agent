import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = dirname(require.resolve('minecraft-data/package.json'));
const viewerRoot = dirname(require.resolve('prismarine-viewer/package.json'));
const chunkRoot = dirname(require.resolve('prismarine-chunk/package.json'));
const allowed = new Set(['blocks', 'blockCollisionShapes', 'tints', 'biomes', 'features', 'version', 'legacy', 'versions', 'protocolVersions']);

export function viewerBuildPlugin() {
  return {
    name: 'viewer-browser-adapters',
    setup(build) {
      const virtual = (filter, name) => build.onResolve({ filter }, () => ({ path: name, namespace: 'viewer-shim' }));
      virtual(/^viewer-polyfills$/, 'polyfills');
      virtual(/^canvas$/, 'canvas');
      virtual(/^prismarine-chunk$/, 'chunk');
      // Workers deserialize chunks; network registries, sign text and binary
      // NBT codecs play no part in geometry. Keep their protocol graphs out.
      virtual(/^prismarine-registry$/, 'registry');
      virtual(/^prismarine-nbt$/, 'nbt');
      build.onResolve({ filter: /^\.\/blockEntity$/ }, args => args.importer.includes('/prismarine-block/')
        ? { path: 'blockEntity', namespace: 'viewer-shim' } : undefined);
      build.onResolve({ filter: /utils(?:\.electron\.js)?$/ }, args => args.importer.startsWith(`${viewerRoot}/viewer/lib/`)
        ? { path: resolve(viewerRoot, 'viewer/lib/utils.web.js') } : undefined);
      build.onResolve({ filter: /^events$/ }, () => ({ path: require.resolve('events/') }));
      build.onLoad({ filter: /.*/, namespace: 'viewer-shim' }, args => {
        const contents = {
          polyfills: `export { Buffer } from 'buffer/';`,
          canvas: `exports.createCanvas=(width,height)=>{const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;return canvas;};`,
          chunk: `const data=require('minecraft-data');const Block=require('prismarine-block');const column=require(${JSON.stringify(resolve(chunkRoot, 'src/pc/1.18/ChunkColumn.js'))});module.exports=version=>{if(version!=='1.21.6')throw new Error('Only Java 1.21.6 is bundled');const registry=data(version);return column(Block(registry),registry);};`,
          registry: `module.exports=version=>require('minecraft-data')(version);`,
          blockEntity: `module.exports=()=>({});`,
          nbt: `// Geometry does not read or write block-entity NBT.\nexports.simplify=value=>value;exports.writeUncompressed=()=>{throw new Error('NBT encoding is unavailable in the mesh worker');};`
        }[args.path];
        return { contents, loader: 'js', resolveDir: root };
      });
      // Replace the source data index with a literal two-version index BEFORE
      // esbuild follows its thousands of require()s. 1.16.2 is tints-only.
      build.onLoad({ filter: /minecraft-data[/\\]data\.js$/ }, () => {
        const data = require('minecraft-data/data.js');
        const entry = version => {
          const fields = version === '1.16.2' ? ['tints', 'version'] : ['blocks', 'blockCollisionShapes', 'biomes', 'tints', 'version'];
          return fields.map(field => {
            const getter = Object.getOwnPropertyDescriptor(data.pc[version], field).get;
            const path = getter.toString().match(/require\(["']([^"']+)["']\)/)[1];
            return `${JSON.stringify(field)}:require(${JSON.stringify(resolve(dataRoot, path))})`;
          }).join(',');
        };
        return { contents: `module.exports={pc:{'1.21.6':{${entry('1.21.6')}},'1.16.2':{${entry('1.16.2')}}},bedrock:{}};`, loader: 'js', resolveDir: dataRoot };
      });
      build.onLoad({ filter: /minecraft-data[/\\].*\.json$/ }, args => {
        const field = basename(args.path, '.json');
        if (!allowed.has(field) || args.path.includes('/schemas/')) return { contents: '{}', loader: 'json' };
      });
    }
  };
}

export async function buildWeb({ outdir = resolve(root, 'dist') } = {}) {
  await mkdir(outdir, { recursive: true });
  const common = {
    absWorkingDir: root, bundle: true, platform: 'browser', format: 'iife', target: ['es2020'],
    minify: true, legalComments: 'none', metafile: true,
    plugins: [viewerBuildPlugin()], inject: ['viewer-polyfills'],
    define: { global: 'globalThis', __dirname: '""', 'globalThis.isElectron': 'false', 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning'
  };
  // Sequential builds keep peak memory small on the shared machine.
  const client = await build({ ...common, entryPoints: ['src/web/viewer-client.js'], outfile: resolve(outdir, 'web-viewer.js') });
  const worker = await build({ ...common, entryPoints: ['src/web/mesh-worker.js'], outfile: resolve(outdir, 'worker.js') });
  for (const [name, result] of [['web-viewer.js', client], ['worker.js', worker]]) {
    const inputs = Object.keys(result.metafile.inputs);
    const forbidden = inputs.filter(path => /minecraft-data\/.*\/(protocol|recipes|items|entities|commands|language)\.json$/.test(path));
    if (forbidden.length) throw new Error(`Unexpected minecraft-data in ${name}: ${forbidden.join(', ')}`);
    const output = Object.values(result.metafile.outputs).find(output => output.entryPoint);
    console.log(`${name}: ${(output.bytes / 1024 / 1024).toFixed(2)} MiB; ${inputs.length} source modules`);
  }
  await writeFile(resolve(outdir, 'viewer-build.json'), JSON.stringify({ worldVersions: ['1.21.6'], assetVersion: '1.21.4', client: client.metafile, worker: worker.metafile }, null, 2));
  return { client, worker };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildWeb().catch(error => { console.error(error); process.exitCode = 1; });
}
