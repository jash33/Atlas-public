import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(workspaceRoot, 'apps/onboarding-site');
const outputRoot = resolve(sourceRoot, 'dist');

rmSync(outputRoot, { force: true, recursive: true });
mkdirSync(outputRoot, { recursive: true });

for (const directory of ['assets', 'lessons', 'reference']) {
  cpSync(resolve(sourceRoot, directory), resolve(outputRoot, directory), {
    recursive: true,
  });
}

cpSync(resolve(sourceRoot, 'index.html'), resolve(outputRoot, 'index.html'));
console.log('Built apps/onboarding-site/dist as an unchanged static course artifact.');
