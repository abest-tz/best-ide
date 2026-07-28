import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
const liveE2e = process.argv.includes('--live-e2e');

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

/** @type {import('esbuild').BuildOptions} */
const liveE2eConfig = {
  entryPoints: ['scripts/live-e2e.ts'],
  bundle: true,
  outfile: 'dist/live-e2e.cjs',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: false,
  minify: false,
  logLevel: 'error',
};

if (liveE2e) {
  await esbuild.build(liveE2eConfig);
  console.log('live-e2e bundle complete');
} else if (watch) {
  const plugin = {
    name: 'rebuild-notify',
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length === 0) {
          console.log(`[esbuild] ${build.initialOptions.outfile} rebuild complete`);
        }
      });
    },
  };
  const ctxs = await Promise.all([
    esbuild.context({ ...extensionConfig, plugins: [plugin] }),
    esbuild.context({ ...webviewConfig, plugins: [plugin] }),
  ]);
  await Promise.all(ctxs.map((ctx) => ctx.watch()));
  console.log('watching...');
} else {
  await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)]);
  console.log('build complete');
}
