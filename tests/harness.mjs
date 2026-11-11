/**
 * Test harness: bundles the TypeScript server modules into a single ESM file
 * with Vite, so `node --test` exercises the real repository code rather than a
 * re-implementation.
 *
 * Vite is used (not raw tsc) because the source uses extension-less relative
 * imports — normal for a bundler — which plain `nodenext` emit rejects.
 *
 * Each test file gets its own throwaway SQLite database via PERSONAL_DATA_DIR,
 * so tests never touch the developer's real journal.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
export const BUILD_DIR = path.join(ROOT, '.data', 'test-build');

const ENTRY = `\
export * as db from '${slash(path.join(ROOT, 'src/lib/server/db.ts'))}';
export * as migrations from '${slash(path.join(ROOT, 'src/lib/server/migrations.ts'))}';
export * as seed from '${slash(path.join(ROOT, 'src/lib/server/legacy-seed.ts'))}';
export * as library from '${slash(path.join(ROOT, 'src/lib/server/library-repository.ts'))}';
export * as logs from '${slash(path.join(ROOT, 'src/lib/server/field-log-repository.ts'))}';
export * as markdown from '${slash(path.join(ROOT, 'src/lib/server/markdown.ts'))}';
export * as guard from '${slash(path.join(ROOT, 'src/lib/server/write-guard.ts'))}';
export * as http from '${slash(path.join(ROOT, 'src/lib/server/http.ts'))}';
`;

function slash(p) {
  return p.replace(/\\/g, '/');
}

/** mtime+size fingerprint of every source the bundle depends on. */
function sourceFingerprint() {
  const roots = [
    path.join(ROOT, 'src/lib/server'),
    path.join(ROOT, 'src/data/library'),
  ];

  const files = [path.join(ROOT, 'src/data/backlog.ts')];

  for (const dir of roots) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isFile() && /\.(ts|mts|js)$/.test(name)) files.push(full);
    }
  }

  return files
    .sort()
    .map((file) => {
      const info = statSync(file);
      return `${path.basename(file)}:${info.size}:${info.mtimeMs}`;
    })
    .join('|');
}

let built = false;

/**
 * Bundle the server modules, rebuilding whenever any source file changed.
 *
 * A mtime+size fingerprint of the sources is written alongside the bundle, so a
 * stale build can never be silently reused after an edit.
 */
export async function buildServerModules(label = 'default') {
  // Each test file gets its own output directory: `node --test` runs files in
  // parallel processes, and a shared outDir would race (one build emptying the
  // directory another is importing from).
  const outDir = path.join(BUILD_DIR, label);
  // Vite's lib mode names the bundle after the entry file's basename.
  const outFile = path.join(outDir, `entry-${label}.js`);
  const stampFile = path.join(outDir, '.source-stamp');
  const stamp = sourceFingerprint();

  if (built && existsSync(outFile) && existsSync(stampFile) && readFileSync(stampFile, 'utf8') === stamp) {
    return outFile;
  }

  mkdirSync(outDir, { recursive: true });

  // The entry lives OUTSIDE outDir, otherwise Vite's output cleaning and
  // entry resolution fight each other.
  const entryDir = path.join(ROOT, '.data', 'test-entry');
  mkdirSync(entryDir, { recursive: true });
  const entryFile = path.join(entryDir, `entry-${label}.ts`);
  writeFileSync(entryFile, ENTRY);

  const { build } = await import('vite');

  await build({
    configFile: false,
    logLevel: 'error',
    root: ROOT,
    build: {
      outDir,
      emptyOutDir: true,
      lib: {
        entry: entryFile,
        formats: ['es'],
      },
      rollupOptions: {
        // Native module: resolved by Node at runtime.
        external: ['better-sqlite3'],
      },
      minify: false,
      target: 'node22',
      ssr: true,
      write: true,
    },
  });

  if (!existsSync(outFile)) {
    const listing = existsSync(BUILD_DIR) ? readdirSync(BUILD_DIR).join(', ') : '(no outDir)';
    throw new Error(`Vite did not emit ${outFile}. Found: ${listing}`);
  }

  writeFileSync(stampFile, stamp);
  built = true;
  return outFile;
}

export function makeTempDataDir(label) {
  return mkdtempSync(path.join(tmpdir(), `journal-test-${label}-`));
}

export function cleanupDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

export { ROOT };
