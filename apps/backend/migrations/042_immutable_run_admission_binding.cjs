exports.up = (pgm) => {
  pgm.addColumn('workflow_runs', {
    admission_binding: { type: 'jsonb' },
  });
  pgm.sql(`
    CREATE FUNCTION protect_workflow_run_admission_binding() RETURNS trigger AS $$
    BEGIN
      IF OLD.admission_binding IS NOT NULL
         AND OLD.admission_binding IS DISTINCT FROM NEW.admission_binding THEN
        RAISE EXCEPTION 'workflow run admission binding is immutable';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER protect_workflow_run_admission_binding
      BEFORE UPDATE OF admission_binding ON workflow_runs
      FOR EACH ROW EXECUTE FUNCTION protect_workflow_run_admission_binding();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER protect_workflow_run_admission_binding ON workflow_runs;
    DROP FUNCTION protect_workflow_run_admission_binding();
  `);
  pgm.dropColumn('workflow_runs', 'admission_binding');
};
