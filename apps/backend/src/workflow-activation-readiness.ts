import type { VersionedCompiledWorkflowVersion } from '@atlas/workflow-ir';

export interface WorkerIrDeclaration {
  workerId: string;
  minimumIrVersion: number;
  maximumIrVersion: number;
}

export interface ActivationReadinessBlocker {
  code: 'execution-grant-pin-mismatch' | 'worker-ir-version-unsupported';
  message: string;
}

export function hasExactMigratedCapabilityPins(
  source: VersionedCompiledWorkflowVersion,
  candidate: VersionedCompiledWorkflowVersion,
  fromCapabilityVersionId: string,
  toCapabilityVersionId: string,
) {
  const sourcePins = source.executionRequirements.requiredCapabilityVersionIds;
  const candidatePins = [...candidate.executionRequirements.requiredCapabilityVersionIds].sort();
  const expectedPins = [
    ...new Set(
      sourcePins.map((pin) => (pin === fromCapabilityVersionId ? toCapabilityVersionId : pin)),
    ),
  ].sort();
  return (
    sourcePins.includes(fromCapabilityVersionId) &&
    expectedPins.length === candidatePins.length &&
    expectedPins.every((pin, index) => pin === candidatePins[index])
  );
}

export function workerIrReadiness(
  declarations: readonly WorkerIrDeclaration[],
  irVersion: number,
  environmentId: string,
) {
  const workers = declarations.map((worker) => ({
    ...worker,
    supported: irVersion >= worker.minimumIrVersion && irVersion <= worker.maximumIrVersion,
  }));
  const blockers: ActivationReadinessBlocker[] = [];
  if (workers.length === 0) {
    blockers.push({
      code: 'worker-ir-version-unsupported',
      message: `No worker has declared an IR version range for environment '${environmentId}'`,
    });
  }
  for (const worker of workers.filter((declaration) => !declaration.supported)) {
    blockers.push({
      code: 'worker-ir-version-unsupported',
      message: `Candidate IR version '${irVersion}' is outside worker '${worker.workerId}' range '${worker.minimumIrVersion}..${worker.maximumIrVersion}'`,
    });
  }
  return { workers, blockers };
}
