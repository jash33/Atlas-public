exports.up = (pgm) => {
  pgm.addColumns('capability_sandbox_target_revisions', {
    control_paths: {
      type: 'jsonb',
      notNull: true,
      default: JSON.stringify({
        state: ['/', '__control', 'state'].join('/'),
        faults: '/__control/faults',
        observations: '/__control/observations',
      }),
    },
  });
  pgm.addColumns('capability_test_data_profile_versions', {
    target_state: { type: 'jsonb', notNull: true, default: '{}' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('capability_test_data_profile_versions', ['target_state']);
  pgm.dropColumns('capability_sandbox_target_revisions', ['control_paths']);
};
