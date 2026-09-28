Overwrites the bound projection's own projectionFingerprint field with an arbitrary value that does not match the recomputed fingerprint of its own {organizationId, workflowStartInputShape, capabilities} content (draft is the unmodified valid fixture).
Expected diagnostic: policyDenial PROJECTION_FINGERPRINT_MISMATCH at projection.projectionFingerprint.
Note: unlike every other fixture, the test harness must NOT call withRecomputedProjectionFingerprint() on this file, or the tampering would be silently repaired before validation runs.
