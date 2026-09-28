import { spawn, type ChildProcess } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { describe, expect, it } from 'vite-plus/test';

const workspaceRoot = resolve(import.meta.dirname, '../..');
const consoleRoot = resolve(workspaceRoot, 'apps/console');
const viteCorePackage = createRequire(
  resolve(workspaceRoot, 'node_modules/vite-plus/package.json'),
).resolve('@voidzero-dev/vite-plus-core/package.json');
const viteCli = resolve(dirname(viteCorePackage), 'dist/vite/node/cli.js');

function createCleanConsoleFixture(): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'atlas-console-boot-'));
  cpSync(resolve(consoleRoot, 'src'), resolve(fixtureRoot, 'src'), { recursive: true });
  copyFileSync(resolve(consoleRoot, 'index.html'), resolve(fixtureRoot, 'index.html'));
  writeFileSync(
    resolve(fixtureRoot, 'vite.config.ts'),
    `export { default } from ${JSON.stringify(resolve(consoleRoot, 'vite.config.ts'))};\n`,
  );

  for (const packageName of ['@tanstack/react-table', 'd3', 'react', 'react-dom', 'yaml', 'zod']) {
    const target = resolve(fixtureRoot, 'node_modules', packageName);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(resolve(consoleRoot, 'node_modules', packageName), target, 'junction');
  }

  for (const packageName of ['@atlas/demo-estate', '@atlas/workflow-ir']) {
    const packageDirectory = basename(packageName);
    const packageRoot = resolve(fixtureRoot, 'node_modules', '@atlas', packageDirectory);
    mkdirSync(packageRoot, { recursive: true });
    copyFileSync(
      resolve(workspaceRoot, 'packages', packageDirectory, 'package.json'),
      resolve(packageRoot, 'package.json'),
    );
    symlinkSync(
      resolve(workspaceRoot, 'packages', packageDirectory, 'src'),
      resolve(packageRoot, 'src'),
      'junction',
    );
  }
  return fixtureRoot;
}

async function waitForConsole(child: ChildProcess, output: () => string): Promise<number> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Console exited before serving HTTP:\n${output()}`);
    }

    const plainOutput = stripVTControlCharacters(output());
    const urlMatch = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(plainOutput);
    if (urlMatch?.[1] !== undefined) {
      const port = Number(urlMatch[1]);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`);
        if (response.ok) return port;
      } catch {
        // The listener is not ready yet.
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Console did not start within 15 seconds:\n${output()}`);
}

async function stopConsole(child: ChildProcess) {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolvePromise) => {
    child.once('exit', () => resolvePromise());
    child.kill('SIGKILL');
  });
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!address || typeof address === 'string') throw new Error('No test port was assigned');
  return address.port;
}

describe('Console clean boot', () => {
  it('serves workspace-package modules without package dist output', async () => {
    const fixtureRoot = createCleanConsoleFixture();
    const port = await availablePort();
    let output = '';
    const child = spawn(
      process.execPath,
      [
        viteCli,
        '--config',
        resolve(fixtureRoot, 'vite.config.ts'),
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
      ],
      {
        cwd: fixtureRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    try {
      const port = await waitForConsole(child, () => output);
      for (const route of ['/src/workflows/diagram-model.ts']) {
        const response = await fetch(`http://127.0.0.1:${port}${route}`);
        const source = await response.text();
        expect(
          response.status,
          `${route} should resolve from workspace source.\n${source}\n${output}`,
        ).toBe(200);
      }
    } finally {
      await stopConsole(child);
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
