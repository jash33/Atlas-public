const resourceControlPaths = {
  resources: '/__control/resources',
  faults: '/__control/faults',
  observations: '/__control/observations',
};

const stateControlPaths = {
  state: ['/', '__control', 'state'].join('/'),
  faults: '/__control/faults',
  observations: '/__control/observations',
};

exports.up = (pgm) => {
  pgm.alterColumn('capability_sandbox_target_revisions', 'control_paths', {
    type: 'jsonb',
    notNull: true,
    default: JSON.stringify(resourceControlPaths),
  });
  pgm.sql(`
    ALTER TABLE capability_sandbox_target_revisions
      DISABLE TRIGGER sandbox_target_revisions_are_immutable;
    UPDATE capability_sandbox_target_revisions
    SET control_paths =
      (control_paths - 'state') || jsonb_build_object('resources', '/__control/resources')
    WHERE control_paths ? 'state';
    ALTER TABLE capability_sandbox_target_revisions
      ENABLE TRIGGER sandbox_target_revisions_are_immutable
  `);
  pgm.sql(`
    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM capability_test_data_profile_versions
        WHERE NOT (
          (
            COALESCE(target_state ->> 'mode' IN ('replace', 'merge'), false)
            AND COALESCE(jsonb_typeof(target_state -> 'resources') = 'array', false)
          )
          OR target_state = '{}'::jsonb
          OR (
            COALESCE(jsonb_typeof(target_state -> 'payments') = 'array', false)
            AND COALESCE(jsonb_typeof(target_state -> 'invoices') = 'array', false)
          )
        )
      ) THEN
        RAISE EXCEPTION
          'cannot migrate unsupported capability test-data target state to resource controls';
      END IF;
    END
    $migration$;

    ALTER TABLE capability_test_data_profile_versions
      DISABLE TRIGGER test_data_profile_versions_are_immutable;
    UPDATE capability_test_data_profile_versions
    SET target_state = jsonb_build_object(
      'mode', 'replace',
      'resources',
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'service', 'payments',
          'collection', 'payments',
          'id', payment ->> 'paymentId',
          'document', payment
        ))
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(target_state -> 'payments') = 'array'
            THEN target_state -> 'payments' ELSE '[]'::jsonb END
        ) payment
      ), '[]'::jsonb) ||
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'service', 'billing',
          'collection', 'invoices',
          'id', invoice ->> 'invoiceId',
          'document', invoice
        ))
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(target_state -> 'invoices') = 'array'
            THEN target_state -> 'invoices' ELSE '[]'::jsonb END
        ) invoice
      ), '[]'::jsonb)
    )
    WHERE NOT (
      COALESCE(target_state ->> 'mode' IN ('replace', 'merge'), false)
      AND COALESCE(jsonb_typeof(target_state -> 'resources') = 'array', false)
    );
    ALTER TABLE capability_test_data_profile_versions
      ENABLE TRIGGER test_data_profile_versions_are_immutable
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM capability_test_data_profile_versions
        WHERE target_state ->> 'mode' IS DISTINCT FROM 'replace'
           OR jsonb_typeof(target_state -> 'resources') IS DISTINCT FROM 'array'
           OR EXISTS (
             SELECT 1
             FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(target_state -> 'resources') = 'array'
                 THEN target_state -> 'resources' ELSE '[]'::jsonb END
             ) resource
             WHERE (resource ->> 'service', resource ->> 'collection')
               NOT IN (('payments', 'payments'), ('billing', 'invoices'))
           )
      ) THEN
        RAISE EXCEPTION
          'cannot downgrade resource controls containing non-legacy test-data profiles';
      END IF;
    END
    $migration$;

    ALTER TABLE capability_test_data_profile_versions
      DISABLE TRIGGER test_data_profile_versions_are_immutable;
    UPDATE capability_test_data_profile_versions
    SET target_state = jsonb_build_object(
      'payments',
      COALESCE((
        SELECT jsonb_agg(resource -> 'document')
        FROM jsonb_array_elements(target_state -> 'resources') resource
        WHERE resource ->> 'service' = 'payments'
          AND resource ->> 'collection' = 'payments'
      ), '[]'::jsonb),
      'invoices',
      COALESCE((
        SELECT jsonb_agg(resource -> 'document')
        FROM jsonb_array_elements(target_state -> 'resources') resource
        WHERE resource ->> 'service' = 'billing'
          AND resource ->> 'collection' = 'invoices'
      ), '[]'::jsonb)
    );
    ALTER TABLE capability_test_data_profile_versions
      ENABLE TRIGGER test_data_profile_versions_are_immutable
  `);
  pgm.sql(`
    ALTER TABLE capability_sandbox_target_revisions
      DISABLE TRIGGER sandbox_target_revisions_are_immutable;
    UPDATE capability_sandbox_target_revisions
    SET control_paths =
      (control_paths - 'resources') ||
      jsonb_build_object('state', '/' || '__control' || '/state')
    WHERE control_paths ->> 'resources' = '/__control/resources';
    ALTER TABLE capability_sandbox_target_revisions
      ENABLE TRIGGER sandbox_target_revisions_are_immutable
  `);
  pgm.alterColumn('capability_sandbox_target_revisions', 'control_paths', {
    type: 'jsonb',
    notNull: true,
    default: JSON.stringify(stateControlPaths),
  });
};
