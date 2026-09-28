const oldValues = "'compatible', 'conditional', 'breaking'";
const newValues = `${oldValues}, 'metadata'`;

function replaceClassificationConstraint(pgm, table, values) {
  pgm.dropConstraint(table, `${table}_classification_check`);
  pgm.addConstraint(table, `${table}_classification_check`, {
    check: `classification IN (${values})`,
  });
}

exports.up = (pgm) => {
  replaceClassificationConstraint(pgm, 'compatibility_diffs', newValues);
  replaceClassificationConstraint(pgm, 'capability_discovery_changes', newValues);
};

exports.down = (pgm) => {
  pgm.sql(
    "UPDATE compatibility_diffs SET classification = 'conditional' WHERE classification = 'metadata'",
  );
  pgm.sql(
    "UPDATE capability_discovery_changes SET classification = 'conditional' WHERE classification = 'metadata'",
  );
  replaceClassificationConstraint(pgm, 'compatibility_diffs', oldValues);
  replaceClassificationConstraint(pgm, 'capability_discovery_changes', oldValues);
};
