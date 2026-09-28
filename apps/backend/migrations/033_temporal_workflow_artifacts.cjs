exports.up = (pgm) => {
  pgm.addColumns('workflow_approvals', {
    artifact_id: { type: 'char(64)' },
    artifact_manifest: { type: 'jsonb' },
  });
  pgm.createIndex('workflow_approvals', ['organization_id', 'environment_id', 'artifact_id'], {
    unique: true,
    where: 'artifact_id IS NOT NULL',
  });
  pgm.addColumn('workflow_runs', {
    artifact_id: { type: 'char(64)' },
  });
  pgm.addColumns('workflow_activations', {
    previous_artifact_id: { type: 'char(64)' },
    current_artifact_id: { type: 'char(64)' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('workflow_activations', ['previous_artifact_id', 'current_artifact_id']);
  pgm.dropColumn('workflow_runs', 'artifact_id');
  pgm.dropColumns('workflow_approvals', ['artifact_id', 'artifact_manifest']);
};
