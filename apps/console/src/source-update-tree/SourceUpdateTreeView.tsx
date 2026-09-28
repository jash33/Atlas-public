import { capabilityDetailHash, workflowDetailHash } from '../changes/changes.js';
import type { SourceUpdateCoverage, SourceUpdateTree } from './tree.js';

function nodeClass(kind: string, coverage: SourceUpdateCoverage) {
  return `sut-node sut-${kind} sut-coverage-${coverage}`;
}

export function SourceUpdateTreeView({ tree }: { tree: SourceUpdateTree }) {
  return (
    <div className="sut" aria-label="Blast radius">
      <div className={nodeClass('source', tree.coverage)}>
        <span>Source</span>
        <strong>{tree.serviceId}</strong>
      </div>
      <ul className="sut-capabilities">
        {tree.capabilityVersions.map((capability) => (
          <li
            className={nodeClass('capability', capability.coverage)}
            key={capability.capabilityVersionId}
          >
            <a href={capabilityDetailHash(capability.capabilityVersionId)}>
              <span>Capability version</span>
              <code>{capability.capabilityVersionId}</code>
            </a>
            <ul className="sut-workflows">
              {capability.workflowVersions.map((workflow) => (
                <li
                  className={nodeClass('workflow', workflow.coverage)}
                  key={workflow.workflowVersionId}
                >
                  <a href={workflowDetailHash(workflow.workflowVersionId)}>
                    <span>Workflow version</span>
                    <code>{workflow.workflowVersionId}</code>
                  </a>
                  <ul className="sut-steps">
                    {workflow.steps.map((stepId) => (
                      <li className={nodeClass('step', workflow.coverage)} key={stepId}>
                        <span>Step</span>
                        <code>{stepId}</code>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
