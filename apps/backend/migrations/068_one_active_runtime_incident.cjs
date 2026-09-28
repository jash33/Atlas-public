exports.up = (pgm) => {
  pgm.createIndex(
    'runtime_contract_mismatches',
    [
      'organization_id',
      'environment_id',
      'capability_identity_id',
      'operation_id',
      'reason',
      'field_path',
    ],
    {
      name: 'runtime_contract_mismatches_one_active_identity',
      unique: true,
      where: "state = 'active'",
    },
  );
};

exports.down = (pgm) => {
  pgm.dropIndex(
    'runtime_contract_mismatches',
    [
      'organization_id',
      'environment_id',
      'capability_identity_id',
      'operation_id',
      'reason',
      'field_path',
    ],
    { name: 'runtime_contract_mismatches_one_active_identity' },
  );
};
