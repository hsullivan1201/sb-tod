/**
 * Copy the freshly-built dist to the mod root that the game actually
 * loads from.
 *
 * The game loads from `~/Library/Application Support/metro-maker4/mods/sb-tod/dist/`
 * (or platform equivalent). When working in a git worktree under
 * `.claude/worktrees/<name>/`, `pnpm build` writes into the WORKTREE's
 * `dist/` — not the path the game is reading. Without this script the
 * game keeps loading the previous build until we manually copy.
 *
 * No-op (with a friendly message) when the script can't find a parent
 * mod directory — e.g. someone cloned the repo standalone outside the
 * worktree layout. The build still succeeds in that case.
 */

import { existsSync, copyFileSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const cwd = process.cwd();
const wtDist = join(cwd, 'dist', 'index.js');

if (!existsSync(wtDist)) {
  console.warn('[copy-to-parent] dist/index.js not found — did vite build succeed?');
  process.exit(0);
}

// Walk up looking for a `.claude/worktrees/<x>` ancestor; the parent
// mod root is its grandparent (the directory containing `.claude`).
let cur = cwd;
let parentRoot: string | null = null;
for (let i = 0; i < 6; i++) {
  const parts = cur.split('/');
  const idx = parts.lastIndexOf('worktrees');
  if (idx > 0 && parts[idx - 1] === '.claude') {
    parentRoot = parts.slice(0, idx - 1).join('/');
    break;
  }
  const next = dirname(cur);
  if (next === cur) break;
  cur = next;
}

if (!parentRoot) {
  console.log('[copy-to-parent] not in a .claude/worktrees layout — skipping copy.');
  process.exit(0);
}

const parentDist = resolve(parentRoot, 'dist');
const parentIndex = join(parentDist, 'index.js');

if (!existsSync(parentDist)) {
  mkdirSync(parentDist, { recursive: true });
}

copyFileSync(wtDist, parentIndex);
const size = statSync(parentIndex).size;
console.log(`[copy-to-parent] copied dist/index.js → ${parentIndex} (${(size / 1024).toFixed(1)} kB)`);

// Also copy manifest.json if present, so a manifest tweak in the
// worktree gets picked up too.
const wtManifest = join(cwd, 'dist', 'manifest.json');
if (existsSync(wtManifest)) {
  copyFileSync(wtManifest, join(parentDist, 'manifest.json'));
}
