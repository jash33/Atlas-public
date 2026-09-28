exports.up = (pgm) => {
  pgm.addColumn('manifest_annotations', {
    field_renames: { type: 'jsonb', notNull: true, default: '[]' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('manifest_annotations', 'field_renames');
};
