import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

function defaultRunDocker(args) {
  execFileSync('docker', args, { stdio: 'inherit' });
}

export function pruneAtlasDockerStorage({
  runDocker = defaultRunDocker,
  output = console.log,
  buildCache = 'aged',
} = {}) {
  runDocker(['image', 'prune', '--force', '--filter', 'label=com.docker.compose.project=atlas']);
  if (buildCache !== 'preserve') {
    runDocker([
      'builder',
      'prune',
      '--force',
      ...(buildCache === 'include-recent' ? [] : ['--filter', 'until=24h']),
    ]);
  }
  output(
    buildCache !== 'preserve'
      ? buildCache === 'include-recent'
        ? 'Removed dangling Atlas images and Docker build cache without an age cutoff.'
        : 'Removed dangling Atlas images and Docker build cache older than 24 hours.'
      : 'Removed dangling Atlas images; shared Docker build cache was preserved.',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const includeRecent = process.argv.includes('--include-recent') || process.argv.includes('--all');
  if (process.argv.includes('--all')) {
    console.warn('--all is deprecated; use --include-recent instead.');
  }
  pruneAtlasDockerStorage({ buildCache: includeRecent ? 'include-recent' : 'aged' });
}
