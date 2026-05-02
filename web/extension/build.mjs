import { build, context } from 'esbuild'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

const watch = process.argv.includes('--watch')

async function copy(src, dst) {
  await mkdir(dirname(dst), { recursive: true })
  await copyFile(src, dst)
}

async function copyStatic() {
  await Promise.all([
    copy('src/manifest.json', 'dist/manifest.json'),
    copy('src/popup/popup.html', 'dist/popup/popup.html'),
    copy('src/popup/popup.css', 'dist/popup/popup.css'),
    copy('src/content/sidebar.css', 'dist/content/sidebar.css'),
  ])
}

const SHARED = {
  bundle: true,
  target: 'chrome120',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
}

const MODULE_BUILD = {
  ...SHARED,
  format: 'esm',
  entryPoints: { background: 'src/background.ts' },
  outdir: 'dist',
}

const IIFE_BUILD = {
  ...SHARED,
  format: 'iife',
  entryPoints: {
    'content/linkedin': 'src/content/linkedin.ts',
    'content/facebook': 'src/content/facebook.ts',
    'popup/popup': 'src/popup/popup.ts',
  },
  outdir: 'dist',
}

async function run() {
  await rm('dist', { recursive: true, force: true })
  await mkdir('dist', { recursive: true })

  if (watch) {
    const ctxs = await Promise.all([context(MODULE_BUILD), context(IIFE_BUILD)])
    await Promise.all(ctxs.map((c) => c.watch()))
    await copyStatic()
    console.log('[ri-extension] watching for changes…')
  } else {
    await Promise.all([build(MODULE_BUILD), build(IIFE_BUILD)])
    await copyStatic()
    console.log('[ri-extension] built → dist/')
  }
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
