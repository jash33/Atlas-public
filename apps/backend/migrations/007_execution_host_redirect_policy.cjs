exports.up = (pgm) => {
  pgm.addColumn('capability_host_policies', {
    allow_redirects: { type: 'boolean', notNull: true, default: false },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('capability_host_policies', 'allow_redirects');
};
