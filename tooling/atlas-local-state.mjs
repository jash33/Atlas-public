import { execFileSync } from 'node:child_process';

export const atlasComposeProject = 'atlas';
// TODO(#148-transition-removal): remove these exact retired names after the local rename window.
export const retiredAtlasResourceNames = Object.freeze({
  containers: Object.freeze([
    'atlas-worker-production-like-1',
    'atlas-temporal-namespace-production-like-1',
  ]),
  volumes: Object.freeze(['atlas-production-like-worker-secrets']),
});

function defaultRunDocker(args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function parseJson(value, description) {
  try {
    return JSON.parse(String(value));
  } catch {
    throw new Error(`Refusing local state cleanup: Docker returned invalid ${description}`);
  }
}

function parseDockerNameList(value) {
  return String(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isResolvedDockerName(name) {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name);
}

function labelForContainer(runDocker, name, label) {
  const inspection = parseJson(
    runDocker(['container', 'inspect', name]),
    `container inspection for ${name}`,
  );
  return inspection[0]?.Config?.Labels?.[label];
}

function projectLabelForVolume(runDocker, name) {
  const inspection = parseJson(
    runDocker(['volume', 'inspect', name]),
    `volume inspection for ${name}`,
  );
  return inspection[0]?.Labels?.['com.docker.compose.project'];
}

function exactRetiredContainers(runDocker) {
  return retiredAtlasResourceNames.containers.filter((name) =>
    parseDockerNameList(
      runDocker([
        'container',
        'ls',
        '--all',
        '--filter',
        `name=^/${name}$`,
        '--format',
        '{{.Names}}',
      ]),
    ).includes(name),
  );
}

function exactRetiredVolumes(runDocker) {
  return retiredAtlasResourceNames.volumes.filter((name) =>
    parseDockerNameList(
      runDocker(['volume', 'ls', '--filter', `name=${name}`, '--format', '{{.Name}}']),
    ).includes(name),
  );
}

export function createAtlasDockerBoundary({
  composePrefix,
  runDocker = defaultRunDocker,
  output = console.log,
}) {
  function runCompose(args) {
    return runDocker([...composePrefix, ...args]);
  }

  function resolveCleanupTargets() {
    const config = parseJson(runCompose(['config', '--format', 'json']), 'Compose configuration');
    if (config.name !== atlasComposeProject) {
      throw new Error(
        `Refusing local state cleanup: expected Compose project ${atlasComposeProject}, received ${String(config.name ?? 'unresolved')}`,
      );
    }

    const containers = [
      ...parseDockerNameList(
        runDocker([
          'container',
          'ls',
          '--all',
          '--filter',
          `label=com.docker.compose.project=${atlasComposeProject}`,
          '--format',
          '{{.Names}}',
        ]),
      ),
      ...exactRetiredContainers(runDocker),
    ].filter(
      (name) =>
        isResolvedDockerName(name) &&
        (retiredAtlasResourceNames.containers.includes(name) ||
          labelForContainer(runDocker, name, 'com.docker.compose.project') === atlasComposeProject),
    );
    const volumes = [
      ...parseDockerNameList(
        runDocker([
          'volume',
          'ls',
          '--filter',
          `label=com.docker.compose.project=${atlasComposeProject}`,
          '--format',
          '{{.Name}}',
        ]),
      ),
      ...exactRetiredVolumes(runDocker),
    ].filter(
      (name) =>
        isResolvedDockerName(name) &&
        (retiredAtlasResourceNames.volumes.includes(name) ||
          projectLabelForVolume(runDocker, name) === atlasComposeProject),
    );

    return {
      project: atlasComposeProject,
      containers: [...new Set(containers)].sort(),
      volumes: [...new Set(volumes)].sort(),
    };
  }

  function removeLocalState() {
    const targets = resolveCleanupTargets();
    output(`Removing disposable Atlas local state in Compose project ${targets.project}.
  Containers (${targets.containers.length}): ${targets.containers.join(', ') || 'none'}
  Volumes (${targets.volumes.length}): ${targets.volumes.join(', ') || 'none'}`);
    if (targets.containers.length > 0) {
      runDocker(['container', 'rm', '--force', ...targets.containers]);
    }
    if (targets.volumes.length > 0) {
      runDocker(['volume', 'rm', ...targets.volumes]);
    }
    runCompose(['down', '--volumes', '--remove-orphans']);
    return targets;
  }

  function resolveLegacyMarkers() {
    const targets = resolveCleanupTargets();
    return {
      containers: targets.containers.filter((name) => {
        if (retiredAtlasResourceNames.containers.includes(name)) return true;
        return labelForContainer(runDocker, name, 'com.docker.compose.service')?.includes(
          'production-like',
        );
      }),
      volumes: targets.volumes.filter((name) => retiredAtlasResourceNames.volumes.includes(name)),
    };
  }

  return { removeLocalState, resolveCleanupTargets, resolveLegacyMarkers, runCompose };
}
