// Illustrative scores only. These are not calculated from customer data.
export const sources = [
  {
    id: 'description',
    label: 'API spec',
    name: 'API descriptions',
    description: 'What the authored or generated contract declares.',
    issue: 264,
  },
  {
    id: 'traffic',
    label: 'Workflow traffic',
    name: 'Workflow traffic',
    description: 'What happened during authorized Atlas runs.',
    issue: 265,
  },
  {
    id: 'gateway',
    label: 'Gateway',
    name: 'Gateways & middleware',
    description: 'Customer observations beyond Atlas traffic.',
    issue: 266,
  },
  {
    id: 'tests',
    label: 'Tests',
    name: 'Customer test suites',
    description: 'Expectations checked against an identified build.',
    issue: 267,
  },
  {
    id: 'application',
    label: 'App & database',
    name: 'Application & deployment changes',
    description: 'Deployed versions and code, ORM, or database changes.',
    issue: 268,
  },
] as const;

export type SourceId = (typeof sources)[number]['id'];
export type EvidenceStatus =
  | 'current'
  | 'mismatch'
  | 'partial'
  | 'stale'
  | 'unavailable'
  | 'missing'
  | 'unobserved';
export const statusLabels: Record<EvidenceStatus, string> = {
  current: 'Current',
  mismatch: 'Mismatch',
  partial: 'Partial',
  stale: 'Stale',
  unavailable: 'Unavailable',
  missing: 'Not connected',
  unobserved: 'No observations',
};
export interface SourceEvidence {
  status: EvidenceStatus;
  detail: string;
  checked: string;
}
export interface CapabilityConfidence {
  id: string;
  service: string;
  method: string;
  path: string;
  contract: string;
  build: string;
  score: number | null;
  reason: string;
  next: string;
  gap: string;
  impact: string;
  lastChecked: string;
  evidence: Record<SourceId, SourceEvidence>;
}

const missing = (detail = 'This source is not connected.'): SourceEvidence => ({
  status: 'missing',
  detail,
  checked: '—',
});

export const capabilities: CapabilityConfidence[] = [
  {
    id: 'getInvoice',
    service: 'Billing',
    method: 'GET',
    path: '/invoices/{id}',
    contract: 'billing@7',
    build: 'b184',
    score: 18,
    reason: 'A response is missing customerId, although the spec still requires it.',
    next: 'Check the provider change and the customerId expectation.',
    gap: 'Other invoice variants have not been checked.',
    impact: 'Collect payment v3 · Read invoice: required dependency affected.',
    lastChecked: '2 min ago',
    evidence: {
      description: {
        status: 'current',
        detail:
          'Published spec unchanged; customerId is still required. Fetch success does not verify behavior.',
        checked: '10:18 UTC',
      },
      traffic: {
        status: 'mismatch',
        detail: 'HTTP 200 response omitted customerId on build b184.',
        checked: '10:16 UTC',
      },
      gateway: {
        status: 'unavailable',
        detail:
          'Access denied. Last success 10:10; next attempt 10:22. Earlier mismatch remains open.',
        checked: '10:17 UTC',
      },
      tests: {
        status: 'partial',
        detail: 'Candidate b185 passed selected cases; it is not deployed.',
        checked: '10:09 UTC',
      },
      application: {
        status: 'current',
        detail: 'Production deployment confirms build b184.',
        checked: '10:18 UTC',
      },
    },
  },
  {
    id: 'payInvoice',
    service: 'Payments',
    method: 'POST',
    path: '/invoices/{id}/payment',
    contract: 'payments@4',
    build: 'p90',
    score: 92,
    reason: 'Recent traffic and reviewed tests agree for the deployed build.',
    next: 'Keep checking during authorized runs.',
    gap: 'Rare provider failures remain untested.',
    impact: 'Collect payment v3 · Pay invoice: no mismatch observed in checked cases.',
    lastChecked: '1 min ago',
    evidence: {
      description: missing(
        'No maintained spec. Reviewed operation expectations are supplied separately in this example.',
      ),
      traffic: {
        status: 'current',
        detail: '24 authorized runs met the reviewed response expectations on p90.',
        checked: '10:19 UTC',
      },
      gateway: missing('No customer gateway integration; Atlas traffic is observed directly.'),
      tests: {
        status: 'current',
        detail: 'Reviewed request, response, and duplicate-effect tests passed for deployed p90.',
        checked: '10:12 UTC',
      },
      application: missing(
        'No continuous application or database feed. Build p90 is linked in the reviewed test record.',
      ),
    },
  },
  {
    id: 'lookupCustomer',
    service: 'Legacy CRM',
    method: 'GET',
    path: '/customers/{id}',
    contract: 'crm@2',
    build: 'Unknown',
    score: 42,
    reason: 'The description is reachable; current application behavior is unverified.',
    next: 'Add an observation from an authorized run or a mapped integration test.',
    gap: 'No deployed build identity or runtime evidence.',
    impact: 'Customer onboarding v1 · Look up customer: current behavior unknown.',
    lastChecked: '5 min ago',
    evidence: {
      description: {
        status: 'current',
        detail: 'Description fetched successfully. Last content review: 20 August.',
        checked: '10:15 UTC',
      },
      traffic: {
        status: 'unobserved',
        detail: 'Connected, but this operation has not run. No samples to check.',
        checked: '—',
      },
      gateway: missing(),
      tests: missing(),
      application: missing(),
    },
  },
  {
    id: 'getStock',
    service: 'Inventory',
    method: 'GET',
    path: '/stock/{sku}',
    contract: 'inventory@4',
    build: 'i32 · last known',
    score: 30,
    reason: 'Earlier responses disagreed with the contract; recent checks are unavailable.',
    next: 'Restore collection and verify the available field.',
    gap: 'No evidence yet that the provider recovered.',
    impact: 'Reserve stock v1 · Read stock: prior mismatch still needs action.',
    lastChecked: '40 min ago',
    evidence: {
      description: {
        status: 'stale',
        detail: 'Last successful description fetch at 09:30; scheduled refresh missed.',
        checked: '09:30 UTC',
      },
      traffic: {
        status: 'mismatch',
        detail: 'available was not an integer. No later pass has been observed.',
        checked: '09:40 UTC',
      },
      gateway: {
        status: 'unavailable',
        detail: 'Connection timed out at 10:17; last success 09:35; retry 10:22.',
        checked: '10:17 UTC',
      },
      tests: missing(),
      application: {
        status: 'stale',
        detail: 'Deployment record is from yesterday. Current instances are unverified.',
        checked: 'Yesterday',
      },
    },
  },
  {
    id: 'getAccount',
    service: 'Accounts',
    method: 'GET',
    path: '/accounts/{id}',
    contract: 'accounts@3',
    build: 'a26',
    score: 78,
    reason: 'Checked responses pass. A database rename needs broader coverage.',
    next: 'Check remaining queries and old/new application overlap.',
    gap: 'Some database-to-operation links are unknown.',
    impact: 'Account sync v2 · Read account: possible internal impact; no confirmed API break.',
    lastChecked: '4 min ago',
    evidence: {
      description: {
        status: 'current',
        detail: 'Public customerId response field unchanged.',
        checked: '10:16 UTC',
      },
      traffic: {
        status: 'current',
        detail: 'Three responses still returned customerId on a26.',
        checked: '10:15 UTC',
      },
      gateway: missing(),
      tests: {
        status: 'partial',
        detail: 'One provider case passes. Old application with the new schema is untested.',
        checked: '10:12 UTC',
      },
      application: {
        status: 'partial',
        detail:
          'Column renamed to account_id; response mapping preserves customerId. Other query links unknown.',
        checked: '10:10 UTC',
      },
    },
  },
  {
    id: 'refundPayment',
    service: 'Payments',
    method: 'POST',
    path: '/payments/{id}/refund',
    contract: 'payments@4',
    build: 'p90',
    score: 64,
    reason: 'Basic cases pass; retry and revoked-token checks were skipped.',
    next: 'Run the skipped cases in the customer test environment.',
    gap: 'Retry safety and revoked-token behavior are not established.',
    impact:
      'Refund order v2 · Refund payment: response checks pass; key behavior remains untested.',
    lastChecked: '8 min ago',
    evidence: {
      description: {
        status: 'current',
        detail: 'Published request and response contract unchanged.',
        checked: '10:12 UTC',
      },
      traffic: {
        status: 'unobserved',
        detail:
          'Connected, but no refunds were requested in this period. No write probes are issued.',
        checked: '—',
      },
      gateway: missing(),
      tests: {
        status: 'partial',
        detail:
          '12 selected cases passed; retry and revoked-token cases skipped. Same JSON shape does not establish correct side effects.',
        checked: '10:11 UTC',
      },
      application: {
        status: 'current',
        detail: 'Production p90 linked to this test report.',
        checked: '10:12 UTC',
      },
    },
  },
  {
    id: 'sendReceipt',
    service: 'Notifications',
    method: 'POST',
    path: '/receipts',
    contract: 'notifications@6',
    build: 'n18',
    score: 88,
    reason: 'Recovery observed against the original expectation on the deployed fix.',
    next: 'Review the recovery evidence through the existing approval process.',
    gap: 'Less common receipt templates remain untested.',
    impact: 'Collect payment v3 · Send receipt: recovery observed; incident history retained.',
    lastChecked: '3 min ago',
    evidence: {
      description: {
        status: 'current',
        detail: 'Original reviewed receiptId requirement retained.',
        checked: '10:17 UTC',
      },
      traffic: {
        status: 'current',
        detail:
          'Three recent responses contain receiptId after the fix. These passes do not erase the prior incident.',
        checked: '10:17 UTC',
      },
      gateway: missing(),
      tests: missing(),
      application: {
        status: 'current',
        detail: 'Provider fix deployed as n18 at 10:05.',
        checked: '10:15 UTC',
      },
    },
  },
  {
    id: 'createShipment',
    service: 'Shipping',
    method: 'POST',
    path: '/shipments',
    contract: 'shipping@1',
    build: 'Unknown',
    score: null,
    reason: 'There is no current evidence to assess this contract.',
    next: 'Connect an available source or wait for an authorized execution.',
    gap: 'All five sources currently unavailable for assessment.',
    impact: 'Ship order v1 · Create shipment: confidence not assessed.',
    lastChecked: 'Never',
    evidence: {
      description: missing(),
      traffic: missing(),
      gateway: missing(),
      tests: missing(),
      application: missing(),
    },
  },
];
