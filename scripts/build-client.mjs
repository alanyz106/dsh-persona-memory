/**
 * Build the prebuilt client bundle (client/client.js) from TS sources.
 *
 * The bundle runs in the dsh web GUI via `window.__ModuleLoader__.load`.
 * esbuild compiles client/src/*.ts to CJS with `react` externalized — the
 * emitted `require("react")` calls bind to the factory's `require` parameter
 * at load time (same contract as the shipped ui-* plugins). No bundler
 * transform touches the DOM globals (fetch/URLSearchParams/setTimeout).
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * The bundle MUST register itself under the package name from package.json:
 * `dsh-client-modules` keys the factory table by `stripClientSuffix(id)` and
 * looks the row up by the package name the host scan resolved, so a hardcoded
 * (stale) id makes the script execute yet register nothing — the boot then
 * fails with `loaded without registering "<package name>" via
 * __ModuleLoader__.load`. Reading the manifest keeps the two in lockstep
 * across renames (see memory/pitfalls.md: 改包名要连带改激活 id).
 */
const { name: packageName } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

const result = await build({
  entryPoints: ['client/src/main.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  external: ['react'],
  write: false,
  minify: false,
  sourcemap: false,
  logLevel: 'warning',
});

const code = result.outputFiles[0].text;

const banner = `/**
 * ${packageName} — browser half ("记忆管理" settings page).
 *
 * AUTO-GENERATED from client/src/*.ts by scripts/build-client.mjs (esbuild).
 * Do not edit by hand — rebuild with \`npm run build:client\`.
 *
 * The page talks to the host through the /api/persona-memory/* route family
 * (registered by lib/admin.ts on the host \`webServer\` service).
 */
window.__ModuleLoader__.load({
  id: ${JSON.stringify(packageName)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
`;

const footer = `
    return module.exports;
  },
});
`;

const bundle = banner + code + footer;
const expectedId = `id: ${JSON.stringify(packageName)},`;
if (!bundle.includes(expectedId)) {
  throw new Error(
    `client bundle does not register ${JSON.stringify(packageName)}; ` +
      `expected ${JSON.stringify(expectedId)} in the window.__ModuleLoader__.load call`,
  );
}
writeFileSync('client/client.js', bundle);
console.log(`client/client.js rebuilt (${bundle.length} bytes, id=${packageName})`);

// The bundle patch activates the plugin by package name; a rename that skips
// this file silently drops the row, so fail the build instead.
const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
if (!patch.includes(`name: '${packageName}'`) && !patch.includes(`name: "${packageName}"`)) {
  throw new Error(
    `cordis.patch.yml does not name ${JSON.stringify(packageName)} — ` +
      `the bundle patch activates plugins by package name and must be updated with it`,
  );
}
