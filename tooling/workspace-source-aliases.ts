import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type PackageJson = {
  dependencies?: Record<string, string>;
  exports?: {
    '.'?: {
      source?: string;
    };
  };
};

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readPackageJson(path: string): PackageJson {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageJson;
}

function sourceAliasesFor(packageJsonPath: string): Record<string, string> {
  const packageJson = readPackageJson(packageJsonPath);
  const aliases: Record<string, string> = {};

  for (const [dependency, version] of Object.entries(packageJson.dependencies ?? {})) {
    if (!dependency.startsWith('@atlas/') || !version.startsWith('workspace:')) continue;

    const dependencyRoot = resolve(workspaceRoot, 'packages', dependency.slice('@atlas/'.length));
    const source = readPackageJson(resolve(dependencyRoot, 'package.json')).exports?.['.']?.source;
    if (source !== undefined) aliases[dependency] = resolve(dependencyRoot, source);
  }

  return aliases;
}

export const consoleWorkspaceSourceAliases = sourceAliasesFor(
  resolve(workspaceRoot, 'apps/console/package.json'),
);
