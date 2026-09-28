import { readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import process from 'node:process';

import ts from 'typescript';

const args = process.argv.slice(2);
const rootFlag = args.indexOf('--root');
const selectedRoot = rootFlag === -1 ? process.cwd() : args[rootFlag + 1];
if (selectedRoot === undefined) {
  throw new Error('--root requires a directory');
}
const workspaceRoot = resolve(selectedRoot);
const sourceRoots = ['apps', 'packages'];
const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts']);
const appPackageNames = new Set([
  '@atlas/console',
  '@atlas/backend',
  '@atlas/mock-services',
  '@atlas/worker',
  '@atlas/ingest',
]);
const frameworkNeutralPackages = new Set(['execution-grant', 'runtime-ports', 'workflow-ir']);
const frameworkImportRoots = ['@hono/node-server', 'hono', 'react', 'react-dom'];

function isPackageOrSubpath(specifier, packageName) {
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

function resolvesIntoLayer(file, specifier, layer) {
  if (!specifier.startsWith('.')) return false;
  const resolvedImport = resolve(file, '..', specifier);
  const layerRoot = resolve(workspaceRoot, layer);
  return resolvedImport === layerRoot || resolvedImport.startsWith(`${layerRoot}${sep}`);
}

function importsApplication(file, specifier, excludedApplication) {
  const resolvedImport = specifier.startsWith('.') ? resolve(file, '..', specifier) : undefined;
  const excludedRoot = excludedApplication
    ? resolve(workspaceRoot, 'apps', excludedApplication)
    : undefined;
  const isInsideExcludedApplication =
    resolvedImport !== undefined &&
    excludedRoot !== undefined &&
    (resolvedImport === excludedRoot || resolvedImport.startsWith(`${excludedRoot}${sep}`));

  return (
    ([...appPackageNames].some(
      (packageName) =>
        packageName !== `@atlas/${excludedApplication}` &&
        isPackageOrSubpath(specifier, packageName),
    ) ||
      resolvesIntoLayer(file, specifier, 'apps')) &&
    !isInsideExcludedApplication
  );
}

function walk(directory) {
  try {
    return readdirSync(directory).flatMap((entry) => {
      const path = resolve(directory, entry);
      if (statSync(path).isDirectory()) {
        return entry === 'dist' || entry === 'node_modules' ? [] : walk(path);
      }
      return [path];
    });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function moduleSpecifiers(sourceFile) {
  const specifiers = [];

  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

const violations = [];
const files = sourceRoots.flatMap((root) => walk(resolve(workspaceRoot, root)));

for (const file of files) {
  const extension = file.slice(file.lastIndexOf('.'));
  if (!sourceExtensions.has(extension) || file.endsWith('.d.ts')) continue;

  const workspacePath = relative(workspaceRoot, file).split(sep).join('/');
  const [layer, packageName] = workspacePath.split('/');
  const isTestFile = /\.(?:test|spec)\.[cm]?tsx?$/.test(file);
  const sourceFile = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );

  for (const specifier of moduleSpecifiers(sourceFile)) {
    if (
      specifier.startsWith('@temporalio/') &&
      !(layer === 'packages' && packageName === 'temporal-adapter')
    ) {
      violations.push(
        `${workspacePath}: Temporal SDK imports are restricted to packages/temporal-adapter`,
      );
    }

    if (layer === 'packages' && importsApplication(file, specifier)) {
      violations.push(`${workspacePath}: shared packages cannot import applications`);
    }

    if (
      layer === 'packages' &&
      frameworkNeutralPackages.has(packageName) &&
      (frameworkImportRoots.some((frameworkPackage) =>
        isPackageOrSubpath(specifier, frameworkPackage),
      ) ||
        specifier.startsWith('node:'))
    ) {
      violations.push(
        `${workspacePath}: framework-neutral packages cannot import framework or Node transport modules`,
      );
    }

    if (
      layer === 'apps' &&
      packageName === 'console' &&
      (importsApplication(file, specifier, 'console') ||
        (specifier.startsWith('node:') && !isTestFile) ||
        isPackageOrSubpath(specifier, 'hono') ||
        specifier.startsWith('@hono/'))
    ) {
      violations.push(
        `${workspacePath}: browser code cannot import server application or transport modules`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Dependency boundaries verified across ${files.length} source files.`);
}
