import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ['src/extension/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
};

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: ['webview/index.tsx'],
  bundle: true,
  outfile: 'dist/webview.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: !production,
  minify: production,
  define: {
    'process.env.NODE_ENV': production ? '"production"' : '"development"',
  },
};

if (watch) {
  const ctxs = await Promise.all([
    esbuild.context(extensionConfig),
    esbuild.context(webviewConfig),
  ]);
  await Promise.all(ctxs.map((ctx) => ctx.watch()));
  console.log('watching...');
} else {
  await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)]);
  console.log('build complete');
}
