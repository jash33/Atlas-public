exports.up = (pgm) => {
  pgm.addColumn('capability_polling_definitions', {
    enabled: { type: 'boolean', notNull: true, default: true },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('capability_polling_definitions', 'enabled');
};
