exports.up = (pgm) => {
  pgm.alterColumn('capability_versions', 'manifest_annotation_id', { notNull: false });
};

exports.down = (pgm) => {
  pgm.alterColumn('capability_versions', 'manifest_annotation_id', { notNull: true });
};
