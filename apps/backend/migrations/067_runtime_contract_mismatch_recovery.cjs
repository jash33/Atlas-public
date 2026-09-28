exports.up = (pgm) => {
  pgm.addColumn('runtime_contract_mismatches', {
    recovered_at: { type: 'timestamptz' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('runtime_contract_mismatches', 'recovered_at');
};
