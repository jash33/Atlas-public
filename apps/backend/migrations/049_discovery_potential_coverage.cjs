exports.up = (pgm) => {
  pgm.addColumns('capability_discovery_changes', {
    potential_coverage: { type: 'jsonb' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('capability_discovery_changes', ['potential_coverage']);
};
