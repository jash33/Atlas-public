import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { graphIdentityView, graphViewFromKey } from '../graph/graph-interactions.js';

import {
  CapabilityMap,
  CapabilityMapResult,
  ClearSimulatedBreakButton,
  capabilityOverviewFocusFromRoute,
  capabilityMapFitView,
  capabilityMapSearchView,
  capabilityViewFromHash,
  capabilityViewHash,
  shouldStartCapabilityMapPan,
  simulatedBreakAfterTargetSelection,
  simulateCapabilityBreak,
  toggleRelationshipTarget,
} from './CapabilityMap.js';
import {
  capabilityBlastRadiusHash,
  capabilityMapEnvironmentAction,
  capabilityMapHash,
  capabilityMapRouteStateFromHash,
  defaultCapabilityMapRouteState,
} from './capability-map-route.js';
import {
  buildCapabilityMapView,
  capabilityIdentityIdForVersion,
  capabilityMapPointFromScreen,
  connectedCapabilityIds,
  filterCapabilityMapOverview,
  filterCapabilityMapVisibility,
  findCapabilityMapItems,
  layoutCapabilityMap,
  relatedCapabilityMapItems,
} from './capability-map-model.js';
import { capabilityMapAccessDeniedMessage } from './data.js';
import type { CapabilityOverview } from './data.js';

const overview: CapabilityOverview = {
  status: 'ready',
  snapshotId: 'overview-123',
  notices: [],
  services: [
    { serviceId: 'kitchen', capabilityIdentityIds: ['cap-create', 'cap-cancel'] },
    { serviceId: 'payments', capabilityIdentityIds: ['cap-pay'] },
  ],
  nodes: [
    {
      capabilityIdentityId: 'cap-cancel',
      capabilityVersionId: 'version-cancel',
      kind: 'openapi',
      serviceId: 'kitchen',
      operationId: 'cancelOrder',
      availability: 'available',
      freshness: 'fresh',
      sourceResolution: 'uncontested',
    },
    {
      capabilityIdentityId: 'cap-create',
      capabilityVersionId: 'version-create',
      kind: 'openapi',
      serviceId: 'kitchen',
      operationId: 'createOrder',
      availability: 'available',
      freshness: 'fresh',
      sourceResolution: 'uncontested',
    },
    {
      capabilityIdentityId: 'cap-pay',
      capabilityVersionId: 'version-pay',
      kind: 'openapi',
      serviceId: 'payments',
      operationId: 'takePayment',
      availability: 'available',
      freshness: 'fresh',
      sourceResolution: 'uncontested',
    },
  ],
  relationships: [
    {
      id: 'relationship-1',
      kind: 'data-flow',
      sourceCapabilityIdentityId: 'cap-create',
      targetCapabilityIdentityId: 'cap-pay',
      evidence: {
        workflowId: 'checkout',
        workflowName: 'Checkout',
        workflowVersionId: 'checkout-v1',
        sourceStepId: 'create-order',
        targetStepId: 'take-payment',
        sourceCapabilityVersionId: 'version-create',
        targetCapabilityVersionId: 'version-pay',
        workflowLifecycle: 'active',
        destinationField: 'orderId',
      },
    },
  ],
};

afterEach(() => vi.unstubAllGlobals());

const drawerEvidenceScope = {
  organizationId: 'org_atlas',
  environmentId: 'development',
  role: 'author',
} as const;

function stubDrawerWindow() {
  vi.stubGlobal('window', {
    innerWidth: 1280,
    localStorage: { getItem: () => null, setItem: () => undefined },
  });
}

describe('Capability Map', () => {
  it('starts canvas panning without capturing pointer events from map items', () => {
    expect(shouldStartCapabilityMapPan(0, false)).toBe(true);
    expect(shouldStartCapabilityMapPan(0, true)).toBe(false);
    expect(shouldStartCapabilityMapPan(1, false)).toBe(false);
  });

  it('keeps a simulated break when the drawer closes and clears it for a new selection', () => {
    expect(simulatedBreakAfterTargetSelection('cap-create', null)).toBe('cap-create');
    expect(
      simulatedBreakAfterTargetSelection('cap-create', { kind: 'node', id: 'cap-pay' }),
    ).toBeNull();
    expect(
      renderToStaticMarkup(createElement(ClearSimulatedBreakButton, { onClear: () => undefined })),
    ).toContain('Clear Simulated Break');
  });

  it('keeps Catalog as the default and makes Map links shareable with the environment', () => {
    expect(capabilityViewFromHash('#/capabilities')).toBe('catalog');
    expect(capabilityViewFromHash('#/capabilities?view=repositories')).toBe('repositories');
    expect(capabilityViewFromHash('#/capabilities?repositoryConnection=repo-1')).toBe(
      'repositories',
    );
    expect(capabilityViewFromHash('#/capabilities?view=map')).toBe('map');
    expect(capabilityViewFromHash('#/capabilities?view=architecture')).toBe('architecture');
    expect(capabilityViewFromHash('#/capabilities?view=evidence')).toBe('evidence');
    expect(capabilityViewFromHash('#/evidence-monitoring')).toBe('evidence');
    expect(capabilityViewHash('evidence', 'production')).toBe(
      '#/capabilities?view=evidence&environmentId=production',
    );
    expect(capabilityViewHash('map', 'production')).toBe(
      '#/capabilities?view=map&environmentId=production',
    );
    expect(capabilityViewHash('repositories', 'production')).toBe(
      '#/capabilities?view=repositories&environmentId=production',
    );
    expect(capabilityViewHash('catalog', 'production')).toBe(
      '#/capabilities?environmentId=production',
    );
  });

  it('restores a saved investigation and keeps unrelated route details', () => {
    const saved = capabilityMapRouteStateFromHash(
      '#/capabilities?view=map&environmentId=production&focusType=change&focusId=change-9&focusTarget=relationship%3Arelationship-1&granularity=grouped&lifecycle=approved-inactive&search=Checkout&disconnected=shown&panel=notes',
    );

    expect(saved).toEqual({
      impactFocusType: 'change',
      impactFocusId: 'change-9',
      focusTarget: { kind: 'relationship', id: 'relationship-1' },
      granularity: 'grouped',
      lifecycle: 'approved-inactive',
      search: 'Checkout',
      showServiceAreas: false,
      includeDisconnected: true,
    });
    expect(
      capabilityMapHash(
        '#/capabilities?view=map&environmentId=production&panel=notes&panX=48',
        'development',
        { ...saved, granularity: 'full', showServiceAreas: true },
      ),
    ).toBe(
      '#/capabilities?view=map&environmentId=development&panel=notes&focusType=change&focusId=change-9&focusTarget=relationship%3Arelationship-1&lifecycle=approved-inactive&search=Checkout&serviceAreas=shown&disconnected=shown',
    );
  });

  it('loads the exact polling failure named by a saved map route', () => {
    expect(
      capabilityOverviewFocusFromRoute(
        capabilityMapRouteStateFromHash(
          '#/capabilities?view=map&environmentId=development&focusType=runtime-mismatch&focusId=runtime-mismatch-1',
        ),
      ),
    ).toEqual({ type: 'runtime-mismatch', id: 'runtime-mismatch-1' });
  });

  it('builds the same focused map link for change surfaces', () => {
    expect(capabilityBlastRadiusHash('production', '42')).toBe(
      '#/capabilities?view=map&environmentId=production&focusType=change&focusId=42',
    );
  });

  it('uses a linked environment but writes a new environment chosen in the Console', () => {
    expect(
      capabilityMapEnvironmentAction(
        '#/capabilities?view=map&environmentId=development',
        '#/capabilities?view=map&environmentId=production',
        'development',
      ),
    ).toEqual({ kind: 'use-linked', environmentId: 'production' });
    expect(
      capabilityMapEnvironmentAction(
        '#/capabilities?view=map&environmentId=development',
        '#/capabilities?view=map&environmentId=development',
        'production',
      ),
    ).toEqual({ kind: 'write-current' });
  });

  it('does not rewrite the route after leaving the capability map', () => {
    expect(
      capabilityMapEnvironmentAction(
        '#/capabilities?view=map&environmentId=development',
        '#/workflows',
        'development',
      ),
    ).toBeNull();
  });

  it('restores an exact capability in the full map instead of fading a grouped map', () => {
    expect(
      capabilityMapRouteStateFromHash(
        '#/capabilities?view=map&granularity=grouped&focusTarget=node%3Acap-pay',
      ),
    ).toMatchObject({
      granularity: 'full',
      focusTarget: { kind: 'node', id: 'cap-pay' },
    });
  });

  it('keeps the past-workflow filter in a saved investigation', () => {
    expect(
      capabilityMapRouteStateFromHash('#/capabilities?view=map&lifecycle=historical'),
    ).toMatchObject({ lifecycle: 'historical' });
  });

  it('shows capabilities, real connections, exact evidence, and a text equivalent', () => {
    const html = renderToStaticMarkup(createElement(CapabilityMap, { overview }));

    expect(html).toContain('Capability map');
    expect(html).toContain('<svg');
    expect(html).toContain('Pan and zoom capability map');
    expect(html).toContain('viewBox="0 0 1400 760"');
    expect(html).toContain('transform="translate(440 219) scale(1)"');
    expect(html).toContain('Show service areas');
    expect(html).toContain('Group supported services');
    expect(html).toContain('Search capabilities, services, workflows, or steps');
    expect(html).toContain('Reset map to fit');
    expect(html).toContain('aria-label="Open full screen map"');
    expect(html).toContain('title="Full screen"');
    expect(html).toContain('class="cap-map-fullscreen-icon"');
    expect(html).toContain('data-direction="outward"');
    expect(html).not.toContain('Copy investigation link');
    expect(html).toContain('role="button"');
    expect(html).toContain('Active workflow');
    expect(html).toContain('2 of 3 capabilities shown');
    expect(html).toContain('Include disconnected capabilities');
    expect(html).toContain('The Catalog remains the complete inventory.');
    expect(html).toContain('createOrder');
    expect(html).toContain('takePayment');
    expect(html).toContain('Data flows');
    expect(html).toContain('Checkout');
    expect(html).toContain('create-order');
    expect(html).toContain('take-payment');
    expect(html).toContain('version-create');
    expect(html).toContain('version-pay');
    expect(html).toContain('Structured text view');
  });

  it('filters connections by workflow lifecycle without hiding capabilities', () => {
    const approvedRelationship = {
      ...overview.relationships[0]!,
      id: 'relationship-approved',
      evidence: {
        ...overview.relationships[0]!.evidence,
        workflowId: 'planned-checkout',
        workflowName: 'Planned checkout',
        workflowVersionId: 'planned-checkout-v1',
        workflowLifecycle: 'approved-inactive' as const,
      },
    };
    const mixedOverview = {
      ...overview,
      relationships: [...overview.relationships, approvedRelationship],
    };

    expect(filterCapabilityMapOverview(mixedOverview, 'active').relationships).toEqual([
      overview.relationships[0],
    ]);
    expect(filterCapabilityMapOverview(mixedOverview, 'approved-inactive').relationships).toEqual([
      approvedRelationship,
    ]);
    expect(filterCapabilityMapOverview(mixedOverview, 'approved-inactive').nodes).toEqual(
      overview.nodes,
    );
    expect(filterCapabilityMapOverview(mixedOverview, 'all').relationships).toHaveLength(2);

    const mixedImpactOverview: CapabilityOverview = {
      ...mixedOverview,
      impact: {
        type: 'change',
        id: 'change-filtered',
        affectedWorkflowCount: 2,
        affectedStepCount: 2,
        incompleteAnalysisCount: 0,
        sources: [],
      },
      nodes: overview.nodes.map((node, index) =>
        index === 0
          ? {
              ...node,
              impact: {
                affected: true,
                isSource: true,
                affectedWorkflowCount: 2,
                usages: [
                  {
                    workflowId: 'checkout',
                    workflowName: 'Checkout',
                    workflowVersionId: 'checkout-v1',
                    workflowLifecycle: 'active',
                    stepId: 'create-order',
                    capabilityVersionId: node.capabilityVersionId,
                    reason: 'This call will fail.',
                    evidence: {
                      discoveryId: 'change-filtered',
                      fromCapabilityVersionId: node.capabilityVersionId,
                      path: [],
                    },
                  },
                  {
                    workflowId: 'planned-checkout',
                    workflowName: 'Planned checkout',
                    workflowVersionId: 'planned-checkout-v1',
                    workflowLifecycle: 'approved-inactive',
                    stepId: 'create-order',
                    capabilityVersionId: node.capabilityVersionId,
                    reason: 'This call will fail.',
                    evidence: {
                      discoveryId: 'change-filtered',
                      fromCapabilityVersionId: node.capabilityVersionId,
                      path: [],
                    },
                  },
                ],
              },
            }
          : node,
      ),
    };
    const activeImpact = filterCapabilityMapOverview(mixedImpactOverview, 'active');
    expect(activeImpact.impact).toMatchObject({
      affectedWorkflowCount: 1,
      affectedStepCount: 1,
    });
    expect(activeImpact.nodes[0]?.impact).toMatchObject({
      affectedWorkflowCount: 1,
      usages: [expect.objectContaining({ workflowVersionId: 'checkout-v1' })],
    });
  });

  it('shows connected or workflow-used capabilities unless disconnected items are requested', () => {
    const connectedOnly = filterCapabilityMapVisibility(overview, 'all', false);
    expect(connectedOnly.nodes.map((node) => node.capabilityIdentityId)).toEqual([
      'cap-create',
      'cap-pay',
    ]);

    const withSingleStepUsage: CapabilityOverview = {
      ...overview,
      nodes: overview.nodes.map((node) =>
        node.capabilityIdentityId === 'cap-cancel'
          ? { ...node, workflowLifecycles: ['approved-inactive'] }
          : node,
      ),
    };
    expect(
      filterCapabilityMapVisibility(withSingleStepUsage, 'approved-inactive', false).nodes.map(
        (node) => node.capabilityIdentityId,
      ),
    ).toContain('cap-cancel');
    expect(filterCapabilityMapVisibility(overview, 'all', true).nodes).toEqual(overview.nodes);
  });

  it('supports keyboard map controls and exposes affected details without relying on color', () => {
    stubDrawerWindow();
    const affectedOverview: CapabilityOverview = {
      ...overview,
      impact: {
        type: 'change',
        id: 'change-9',
        affectedWorkflowCount: 1,
        affectedStepCount: 2,
        incompleteAnalysisCount: 0,
        sources: [
          {
            capabilityIdentityId: 'cap-create',
            capabilityVersionId: 'version-create',
            serviceId: 'kitchen',
            operationId: 'createOrder',
          },
        ],
      },
      nodes: overview.nodes.map((node) =>
        node.capabilityIdentityId === 'cap-create' || node.capabilityIdentityId === 'cap-pay'
          ? {
              ...node,
              impact: {
                affected: true,
                isSource: node.capabilityIdentityId === 'cap-create',
                affectedWorkflowCount: 1,
                usages: [
                  {
                    workflowId: 'checkout',
                    workflowName: 'Checkout',
                    workflowVersionId: 'checkout-v1',
                    workflowLifecycle: 'active' as const,
                    currentState: {
                      isActive: true,
                      quarantine: 'active' as const,
                      ...(node.capabilityIdentityId === 'cap-pay'
                        ? {
                            blockedWorkflowStart: {
                              id: 'blocked-1',
                              toCapabilityVersionId: 'version-create-next',
                              blockedAt: '2026-09-04T14:00:00.000Z',
                            },
                            latestFailedRun: {
                              runId: 'run-contract-failed',
                              failureType: 'MissingOrderId',
                              failedAt: '2026-09-04T14:01:00.000Z',
                            },
                          }
                        : {}),
                    },
                    stepId:
                      node.capabilityIdentityId === 'cap-create' ? 'create-order' : 'take-payment',
                    capabilityVersionId: node.capabilityVersionId,
                    reason:
                      node.capabilityIdentityId === 'cap-create'
                        ? 'This call will fail because createOrder was removed.'
                        : 'This call cannot run because required earlier step create-order will fail.',
                    evidence: {
                      discoveryId: 'change-9',
                      fromCapabilityVersionId: 'version-create',
                      path:
                        node.capabilityIdentityId === 'cap-pay'
                          ? [
                              {
                                kind: 'execution-order' as const,
                                fromStepId: 'create-order',
                                toStepId: 'take-payment',
                                fromCapabilityVersionId: 'version-create',
                                toCapabilityVersionId: 'version-pay',
                              },
                            ]
                          : [],
                      ...(node.capabilityIdentityId === 'cap-pay'
                        ? {
                            sourceStepId: 'create-order',
                          }
                        : {}),
                    },
                  },
                ],
              },
            }
          : {
              ...node,
              impact: { affected: false, isSource: false, affectedWorkflowCount: 0, usages: [] },
            },
      ),
      relationships: overview.relationships.map((relationship) => ({
        ...relationship,
        impact: { affected: true, workflowVersionIds: ['checkout-v1'] },
      })),
    };
    const html = renderToStaticMarkup(
      createElement(CapabilityMap, {
        evidenceScope: drawerEvidenceScope,
        overview: affectedOverview,
        routeState: {
          ...defaultCapabilityMapRouteState,
          impactFocusType: 'change',
          impactFocusId: 'change-9',
          focusTarget: { kind: 'node', id: 'cap-pay' },
        },
      }),
    );

    expect(html).toContain(
      'aria-label="Data flows from kitchen · createOrder to payments · takePayment"',
    );
    expect(html.match(/tabindex="0"/g)?.length).toBeGreaterThanOrEqual(5);
    expect(html.match(/1 affected workflow/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('Blast radius');
    expect(html).toContain('2 workflow items were going to break');
    expect(html).toContain('is-affected');
    expect(html).toContain('change kitchen.createOrder');
    expect(html).toContain('Supported workflow path');
    expect(html).toContain('create-order → take-payment (Runs before)');
    expect(html).toContain('Atlas blocked new starts for this workflow');
    expect(html).toContain('#/runs?runId=run-contract-failed');
    expect(html).toContain('MissingOrderId');
    expect(html).toContain('Structured text view');
    expect(graphViewFromKey(graphIdentityView, 'ArrowRight', { x: 0, y: 0 })).toEqual({
      x: -40,
      y: 0,
      zoom: 1,
    });
    expect(toggleRelationshipTarget(null, 'relationship-1')).toEqual({
      kind: 'relationship',
      id: 'relationship-1',
    });
    expect(
      toggleRelationshipTarget({ kind: 'relationship', id: 'relationship-1' }, 'relationship-1'),
    ).toBeNull();
  });

  it('opens operation and connection evidence when a saved relationship is selected', () => {
    vi.stubGlobal('window', {
      innerWidth: 1280,
      localStorage: { getItem: () => null, setItem: () => undefined },
    });
    const html = renderToStaticMarkup(
      createElement(CapabilityMap, {
        overview,
        routeState: {
          impactFocusType: null,
          impactFocusId: null,
          focusTarget: { kind: 'relationship', id: 'relationship-1' },
          granularity: 'full',
          lifecycle: 'all',
          search: '',
          showServiceAreas: false,
          includeDisconnected: false,
        },
        evidenceScope: {
          organizationId: 'org_atlas',
          environmentId: 'production',
          role: 'author',
        },
      }),
    );

    expect(html).toContain('aria-label="Operation evidence"');
    expect(html).toContain('Selected connection');
    expect(html).toContain('This evidence comes from map snapshot');
    expect(html).toContain('overview-123');
    expect(html).toContain('Checkout, steps create-order → take-payment');
    expect(html).toContain('version-create');
    expect(html).toContain('version-pay');
  });

  it('opens as one complete capability map without replacing capabilities with services', () => {
    const view = buildCapabilityMapView(overview, 'full');
    const layout = layoutCapabilityMap(view, true);

    expect(view.nodes.map((node) => node.id)).toEqual(['cap-create', 'cap-cancel', 'cap-pay']);
    expect(view.nodes.every((node) => node.kind === 'capability')).toBe(true);
    expect(layout.serviceAreas.map((service) => service.serviceId)).toEqual(['kitchen']);
    expect(layout.relationships.map((relationship) => relationship.id)).toEqual(['relationship-1']);
    expect(layout.nodes.find((node) => node.id === 'cap-cancel')).toBeDefined();
  });

  it('groups only useful services and keeps every connection with its exact evidence', () => {
    const secondConnection = {
      ...overview.relationships[0]!,
      id: 'relationship-2',
      evidence: {
        ...overview.relationships[0]!.evidence,
        workflowId: 'rush-checkout',
        workflowName: 'Rush checkout',
        workflowVersionId: 'rush-checkout-v1',
      },
    };
    const overviewWithTwoConnections = {
      ...overview,
      nodes: overview.nodes.map((node) =>
        node.capabilityIdentityId === 'cap-create' || node.capabilityIdentityId === 'cap-pay'
          ? {
              ...node,
              impact: {
                affected: true,
                isSource: node.capabilityIdentityId === 'cap-create',
                affectedWorkflowCount: 1,
                usages: [
                  {
                    workflowId: 'rush-checkout',
                    workflowName: 'Rush checkout',
                    workflowVersionId: 'rush-checkout-v1',
                    workflowLifecycle: 'active' as const,
                    stepId:
                      node.capabilityIdentityId === 'cap-create' ? 'create-order' : 'take-payment',
                    capabilityVersionId: node.capabilityVersionId,
                    reason: 'This call will fail.',
                    evidence: {
                      discoveryId: 'change-10',
                      fromCapabilityVersionId: 'version-create',
                      path: [],
                    },
                  },
                ],
              },
            }
          : node,
      ),
      relationships: [
        ...overview.relationships,
        {
          ...secondConnection,
          impact: { affected: true as const, workflowVersionIds: ['rush-checkout-v1'] },
        },
      ],
    };
    const grouped = buildCapabilityMapView(overviewWithTwoConnections, 'grouped');

    expect(grouped.snapshotId).toBe(overview.snapshotId);
    expect(grouped.nodes.map((node) => node.id)).toEqual(['service:kitchen', 'cap-pay']);
    expect(grouped.nodes.find((node) => node.id === 'service:kitchen')).toMatchObject({
      kind: 'service',
      capabilityIdentityIds: ['cap-create', 'cap-cancel'],
      affectedWorkflowCount: 1,
    });
    expect(grouped.nodes.find((node) => node.id === 'cap-pay')).toMatchObject({
      affectedWorkflowCount: 1,
    });
    expect(grouped.relationships).toHaveLength(1);
    expect(grouped.relationships[0]).toMatchObject({
      sourceNodeId: 'service:kitchen',
      targetNodeId: 'cap-pay',
      relationshipIds: ['relationship-1', 'relationship-2'],
      affectedWorkflowVersionIds: ['rush-checkout-v1'],
    });
    expect(grouped.relationships[0]?.evidence).toEqual([
      overview.relationships[0]?.evidence,
      secondConnection.evidence,
    ]);
    expect(buildCapabilityMapView(overview, 'full').nodes.map((node) => node.id)).toEqual([
      'cap-create',
      'cap-cancel',
      'cap-pay',
    ]);
  });

  it('keeps uncategorized capabilities visible and ignores one overly broad service', () => {
    const broadOverview: CapabilityOverview = {
      ...overview,
      services: [
        {
          serviceId: 'default',
          capabilityIdentityIds: overview.nodes.map((node) => node.capabilityIdentityId),
        },
      ],
      nodes: overview.nodes.map((node) => ({ ...node, serviceId: 'default' })),
    };
    const grouped = buildCapabilityMapView(broadOverview, 'grouped');

    expect(grouped.groupedServiceCount).toBe(0);
    expect(grouped.nodes.map((node) => node.id)).toEqual(['cap-cancel', 'cap-create', 'cap-pay']);
  });

  it('searches capability, service, workflow, and step names without changing the map', () => {
    const view = buildCapabilityMapView(overview, 'full');

    expect([...findCapabilityMapItems(view, 'takePayment').nodeIds]).toEqual(['cap-pay']);
    expect([...findCapabilityMapItems(view, 'kitchen').nodeIds]).toEqual([
      'cap-create',
      'cap-cancel',
    ]);
    expect([...findCapabilityMapItems(view, 'Checkout').relationshipIds]).toEqual([
      'relationship-1',
    ]);
    expect([...findCapabilityMapItems(view, 'take-payment').nodeIds]).toEqual([
      'cap-create',
      'cap-pay',
    ]);
    expect(view.snapshotId).toBe(overview.snapshotId);
  });

  it('centers and fits matching capabilities in the map viewport', () => {
    const nodes = [
      { id: 'left', x: 80, y: 100 },
      { id: 'middle', x: 450, y: 240 },
      { id: 'right', x: 820, y: 380 },
    ];
    const mapSize = { width: 1100, height: 620 };
    const searchView = capabilityMapSearchView(mapSize, nodes, new Set(['middle', 'right']))!;
    const leftEdge = nodes[1]!.x * searchView.zoom + searchView.x;
    const rightEdge = (nodes[2]!.x + 190) * searchView.zoom + searchView.x;

    expect(leftEdge).toBeGreaterThan(0);
    expect(rightEdge).toBeLessThan(mapSize.width);
    expect((leftEdge + rightEdge) / 2).toBeCloseTo(mapSize.width / 2);
    expect(searchView.zoom).toBeGreaterThan(1);
    expect(capabilityMapSearchView(mapSize, nodes, new Set(['missing']))).toBeNull();
  });

  it('opens an incident at readable scale without restoring disconnected capabilities', () => {
    const incidentOverview: CapabilityOverview = {
      ...overview,
      impact: {
        type: 'runtime-mismatch',
        id: 'incident-large-estate',
        affectedEndpointCount: 2,
        affectedWorkflowCount: 1,
        affectedStepCount: 2,
        incompleteAnalysisCount: 0,
        analysis: 'complete',
        occurrenceCount: 1,
        state: 'active',
        sources: [],
      },
      nodes: [
        ...overview.nodes.map((node) => ({
          ...node,
          impact: {
            affected: node.capabilityIdentityId !== 'cap-cancel',
            isSource: node.capabilityIdentityId === 'cap-create',
            affectedWorkflowCount: 1,
            usages: [],
          },
        })),
        ...Array.from({ length: 84 }, (_, index) => ({
          ...overview.nodes[0]!,
          capabilityIdentityId: `isolated-${index}`,
          operationId: `other-${index}`,
        })),
      ],
    };
    const html = renderToStaticMarkup(
      createElement(CapabilityMap, {
        overview: incidentOverview,
        routeState: {
          ...defaultCapabilityMapRouteState,
          impactFocusType: 'runtime-mismatch',
          impactFocusId: 'incident-large-estate',
        },
      }),
    );
    const transform = html.match(/<g transform="translate\(([^ ]+) ([^)]+)\) scale\(([^)]+)\)">/)!;
    const [x, y, zoom] = transform.slice(1).map(Number);
    expect(zoom).toBeGreaterThanOrEqual(1);
    expect(zoom).toBeLessThanOrEqual(1.8);
    const visibleIncidentOverview = filterCapabilityMapVisibility(incidentOverview, 'all', false);
    const layout = layoutCapabilityMap(
      buildCapabilityMapView(visibleIncidentOverview, 'full'),
      false,
    );
    for (const node of layout.nodes.filter((candidate) => candidate.impact?.affected)) {
      expect(node.x * zoom! + x!).toBeGreaterThan(0);
      expect((node.x + 190) * zoom! + x!).toBeLessThan(1400);
      expect(node.y * zoom! + y!).toBeGreaterThan(0);
      expect((node.y + 76) * zoom! + y!).toBeLessThan(760);
    }
    expect(html.match(/class="cap-map-svg-node /g)).toHaveLength(2);
    expect(html).toContain('2 of 87 capabilities shown');
    expect(html).toContain('Reset map to fit');

    const notificationFocusedHtml = renderToStaticMarkup(
      createElement(CapabilityMap, {
        overview: incidentOverview,
        routeState: {
          ...defaultCapabilityMapRouteState,
          impactFocusType: 'runtime-mismatch',
          impactFocusId: 'incident-large-estate',
          focusTarget: { kind: 'node', id: 'cap-create' },
        },
      }),
    );
    expect(notificationFocusedHtml.match(/class="cap-map-svg-node /g)).toHaveLength(2);
    expect(notificationFocusedHtml).toContain('2 of 87 capabilities shown');
  });

  it('focuses a capability and its direct connections without removing other items', () => {
    const view = buildCapabilityMapView(overview, 'full');
    const focused = relatedCapabilityMapItems(view, 'cap-create');

    expect([...focused.nodeIds]).toEqual(['cap-create', 'cap-pay']);
    expect([...focused.relationshipIds]).toEqual(['relationship-1']);
    expect(view.nodes).toHaveLength(3);
    expect([...connectedCapabilityIds(overview)]).toEqual(['cap-create', 'cap-pay']);
  });

  it('simulates the workflows and capabilities affected by a selected capability', () => {
    const view = buildCapabilityMapView(overview, 'full');
    const extendedView = {
      ...view,
      nodes: [...view.nodes, { ...view.nodes[0]!, id: 'cap-receipt', label: 'sendReceipt' }],
      relationships: [
        ...view.relationships,
        {
          ...view.relationships[0]!,
          id: 'relationship-2',
          sourceNodeId: 'cap-pay',
          targetNodeId: 'cap-receipt',
          relationshipIds: ['relationship-2'],
          evidence: [
            {
              ...view.relationships[0]!.evidence[0]!,
              sourceStepId: 'take-payment',
              targetStepId: 'send-receipt',
              sourceCapabilityVersionId: 'version-pay',
              targetCapabilityVersionId: 'version-receipt',
            },
          ],
        },
      ],
    };
    const simulation = simulateCapabilityBreak(extendedView, 'cap-create');

    expect([...simulation.nodeIds]).toEqual(['cap-create', 'cap-pay', 'cap-receipt']);
    expect([...simulation.relationshipIds]).toEqual(['relationship-1', 'relationship-2']);
    expect(simulation.workflows).toEqual([
      { workflowName: 'Checkout', workflowVersionId: 'checkout-v1' },
    ]);

    const disconnected = simulateCapabilityBreak(
      buildCapabilityMapView(overview, 'full'),
      'cap-cancel',
    );
    expect([...disconnected.nodeIds]).toEqual(['cap-cancel']);
    expect(disconnected.relationshipIds.size).toBe(0);
    expect(disconnected.workflows).toEqual([]);
  });

  it('opens the operation drawer with a break simulation action for a selected map capability', () => {
    vi.stubGlobal('window', {
      innerWidth: 1280,
      localStorage: { getItem: () => null, setItem: () => undefined },
    });
    const html = renderToStaticMarkup(
      createElement(CapabilityMap, {
        overview,
        routeState: {
          ...defaultCapabilityMapRouteState,
          focusTarget: { kind: 'node', id: 'cap-create' },
        },
        evidenceScope: {
          organizationId: 'org_atlas',
          environmentId: 'development',
          role: 'author',
        },
      }),
    );

    expect(html).toContain('aria-label="Operation evidence"');
    expect(html).toContain('Operation details');
    expect(html).toContain('Simulate a break');
    expect(html).toContain('This does not change the capability or run any workflow.');
  });

  it('offers break simulation when a grouped map node is selected', () => {
    vi.stubGlobal('window', {
      innerWidth: 1280,
      localStorage: { getItem: () => null, setItem: () => undefined },
    });
    const html = renderToStaticMarkup(
      createElement(CapabilityMap, {
        overview,
        routeState: {
          ...defaultCapabilityMapRouteState,
          granularity: 'grouped',
          includeDisconnected: true,
          focusTarget: { kind: 'node', id: 'service:kitchen' },
        },
        evidenceScope: {
          organizationId: 'org_atlas',
          environmentId: 'development',
          role: 'author',
        },
      }),
    );

    expect(html).toContain('aria-label="Operation evidence"');
    expect(html).toContain('Simulate a break');
  });

  it('lays out a large complete map, cycles, and disconnected capabilities deterministically', () => {
    const nodes = Array.from({ length: 64 }, (_, index) => ({
      ...overview.nodes[0]!,
      capabilityIdentityId: `cap-${String(index).padStart(2, '0')}`,
      capabilityVersionId: `version-${index}`,
      serviceId: index === 63 ? 'uncategorized' : `service-${index % 8}`,
      operationId: `operation-${index}`,
    }));
    const largeOverview: CapabilityOverview = {
      ...overview,
      nodes,
      services: [],
      relationships: [
        {
          ...overview.relationships[0]!,
          id: 'cycle-a',
          sourceCapabilityIdentityId: 'cap-00',
          targetCapabilityIdentityId: 'cap-01',
        },
        {
          ...overview.relationships[0]!,
          id: 'cycle-b',
          sourceCapabilityIdentityId: 'cap-01',
          targetCapabilityIdentityId: 'cap-00',
        },
      ],
    };
    const view = buildCapabilityMapView(largeOverview, 'full');
    const layout = layoutCapabilityMap(view, false);

    expect(layout.nodes).toHaveLength(64);
    expect(layout.relationships.map((relationship) => relationship.id)).toEqual([
      'cycle-a',
      'cycle-b',
    ]);
    expect(layout.relationships).toHaveLength(view.relationships.length);
    const connectedSource = layout.nodes.find((node) => node.id === 'cap-00')!;
    const connectedTarget = layout.nodes.find((node) => node.id === 'cap-01')!;
    const firstIsolated = layout.nodes.find((node) => node.id === 'cap-02')!;
    const secondIsolated = layout.nodes.find((node) => node.id === 'cap-03')!;
    expect(connectedSource).toMatchObject({ x: 42, y: 42 });
    expect(firstIsolated.y).toBe(connectedSource.y);
    expect(secondIsolated.x).toBeGreaterThan(firstIsolated.x);
    expect(secondIsolated.y).toBe(firstIsolated.y);
    expect(connectedTarget.x).toBe(connectedSource.x);
    expect(connectedTarget.y).toBeGreaterThan(connectedSource.y);
    expect(
      new Set(layout.nodes.filter((node) => Number(node.id.slice(4)) >= 2).map((node) => node.y))
        .size,
    ).toBe(3);
    expect(layout.width).toBeGreaterThan(layout.height * 6);
    expect(layout.height).toBeGreaterThanOrEqual(320);
  });

  it('keeps a workflow root on the horizontal rail and stacks its steps downward', () => {
    const nodes = Array.from({ length: 7 }, (_, index) => ({
      ...overview.nodes[0]!,
      capabilityIdentityId: `step-${index}`,
      capabilityVersionId: `step-version-${index}`,
      operationId: `stepOperation${index}`,
    }));
    const relationships = nodes.slice(1).map((node, index) => ({
      ...overview.relationships[0]!,
      id: `step-relationship-${index}`,
      sourceCapabilityIdentityId: nodes[index]!.capabilityIdentityId,
      targetCapabilityIdentityId: node.capabilityIdentityId,
    }));
    const view = buildCapabilityMapView(
      { ...overview, services: [], nodes, relationships },
      'full',
    );
    const layout = layoutCapabilityMap(view, false);

    expect(layout.relationships).toHaveLength(relationships.length);
    expect(layout.nodes[0]).toMatchObject({ id: 'step-0', x: 42, y: 42 });
    expect(layout.nodes.map((node) => node.x)).toEqual(Array(7).fill(42));
    for (let index = 1; index < layout.nodes.length; index += 1) {
      expect(layout.nodes[index]!.y).toBeGreaterThan(layout.nodes[index - 1]!.y);
    }
  });

  it('fits an oversized map only when the user asks to fit it', () => {
    expect(capabilityMapFitView({ width: 14_000, height: 760 })).toEqual({
      zoom: 0.1,
      x: 0,
      y: 342,
    });
  });

  it('keeps navigation accurate when a large map is scaled to fit', () => {
    expect(
      capabilityMapPointFromScreen(
        { width: 1000, height: 500 },
        { left: 10, top: 20, width: 500, height: 500 },
        { x: 260, y: 270 },
      ),
    ).toEqual({ x: 500, y: 250 });
  });

  it('lays out one disconnected capability as a usable map', () => {
    const singleOverview: CapabilityOverview = {
      ...overview,
      services: [],
      nodes: [overview.nodes[0]!],
      relationships: [],
    };
    const layout = layoutCapabilityMap(buildCapabilityMapView(singleOverview, 'full'), false);

    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0]).toMatchObject({ id: 'cap-cancel', x: 42, y: 42 });
    expect({ width: layout.width, height: layout.height }).toEqual({ width: 520, height: 320 });
  });

  it('clearly separates empty and partial results', () => {
    const empty = renderToStaticMarkup(
      createElement(CapabilityMap, {
        overview: {
          ...overview,
          status: 'empty',
          nodes: [],
          relationships: [],
          services: [],
          notices: ['Atlas has not ingested any capabilities for this environment.'],
        },
      }),
    );
    const partial = renderToStaticMarkup(
      createElement(CapabilityMap, {
        overview: {
          ...overview,
          status: 'partial',
          notices: ['One approved workflow could not be read.'],
        },
      }),
    );

    expect(empty).toContain('No capabilities to map');
    expect(empty).toContain('Atlas has not ingested any capabilities for this environment.');
    expect(partial).toContain('Some connections could not be shown');
    expect(partial).toContain('One approved workflow could not be read.');
  });

  it('distinguishes no recorded impact, incomplete analysis, and unavailable history', () => {
    const impact = {
      type: 'change' as const,
      id: 'change-history',
      affectedWorkflowCount: 0,
      affectedStepCount: 0,
      currentlyExposedWorkflowCount: 0,
      currentlyExposedStepCount: 0,
      incompleteAnalysisCount: 0,
      sources: [],
    };
    const noImpact = renderToStaticMarkup(
      createElement(CapabilityMap, {
        overview: { ...overview, impact: { ...impact, analysis: 'complete' } },
      }),
    );
    const incomplete = renderToStaticMarkup(
      createElement(CapabilityMap, {
        overview: {
          ...overview,
          status: 'partial',
          notices: ['One part of this impact analysis could not be completed.'],
          impact: { ...impact, analysis: 'partial', incompleteAnalysisCount: 1 },
        },
      }),
    );
    const unavailable = renderToStaticMarkup(
      createElement(CapabilityMap, {
        overview: {
          ...overview,
          status: 'partial',
          notices: ['Atlas could not find the selected contract change in this environment.'],
          impact: { ...impact, analysis: 'unavailable', incompleteAnalysisCount: 1 },
        },
      }),
    );

    expect(noImpact).toContain('Atlas found no workflow items that were affected');
    expect(incomplete).toContain('this answer may be incomplete');
    expect(incomplete).not.toContain('found no workflow items');
    expect(unavailable).toContain('could not find enough information to check this change');
    expect(unavailable).not.toContain('found no workflow items');
  });

  it('marks an active broken request source red even when no workflow call is affected', () => {
    const runtimeOverview: CapabilityOverview = {
      ...overview,
      impact: {
        type: 'runtime-mismatch',
        id: 'runtime-mismatch-no-affected-workflows',
        state: 'active',
        affectedEndpointCount: 0,
        affectedWorkflowCount: 0,
        affectedStepCount: 0,
        currentlyExposedWorkflowCount: 0,
        currentlyExposedStepCount: 0,
        incompleteAnalysisCount: 0,
        analysis: 'complete',
        occurrenceCount: 1,
        sources: [
          {
            capabilityIdentityId: 'cap-pay',
            capabilityVersionId: 'version-pay',
            serviceId: 'payments',
            operationId: 'takePayment',
          },
        ],
      },
      nodes: overview.nodes.map((node) =>
        node.capabilityIdentityId === 'cap-pay'
          ? {
              ...node,
              impact: {
                affected: false,
                isSource: true,
                affectedWorkflowCount: 0,
                usages: [],
              },
            }
          : node,
      ),
    };

    const html = renderToStaticMarkup(createElement(CapabilityMap, { overview: runtimeOverview }));

    expect(html).toMatch(/cap-map-svg-node-capability[^"\n]*is-broken-source/);
    expect(html).toContain('Broken request source');
  });

  it('shows recorded impact separately from the current workflow situation', () => {
    stubDrawerWindow();
    const historicalOverview: CapabilityOverview = {
      ...overview,
      impact: {
        type: 'change',
        id: 'change-history',
        affectedWorkflowCount: 1,
        affectedStepCount: 1,
        currentlyExposedWorkflowCount: 0,
        currentlyExposedStepCount: 0,
        incompleteAnalysisCount: 0,
        analysis: 'complete',
        recordedAt: '2026-09-04T12:00:00.000Z',
        sources: [],
      },
      nodes: overview.nodes.map((node) =>
        node.capabilityIdentityId === 'cap-pay'
          ? {
              ...node,
              impact: {
                affected: true,
                isSource: false,
                affectedWorkflowCount: 1,
                usages: [
                  {
                    workflowId: 'checkout',
                    workflowName: 'Checkout',
                    workflowVersionId: 'checkout-v1',
                    workflowLifecycle: 'historical',
                    currentState: {
                      isActive: false,
                      quarantine: 'cleared',
                      replacementWorkflowVersionId: 'checkout-v2',
                      replacementActivatedAt: '2026-09-04T13:00:00.000Z',
                      quarantineClearedAt: '2026-09-04T13:00:00.000Z',
                      blockedWorkflowStart: {
                        id: 'block-1',
                        toCapabilityVersionId: 'version-create-new',
                        blockedAt: '2026-09-04T12:01:00.000Z',
                      },
                    },
                    stepId: 'take-payment',
                    capabilityVersionId: 'version-pay-old',
                    reason: 'This call used a response field that was removed.',
                    evidence: {
                      discoveryId: 'change-history',
                      fromCapabilityVersionId: 'version-create-old',
                      path: [],
                    },
                  },
                ],
              },
            }
          : node,
      ),
    };
    const html = renderToStaticMarkup(
      createElement(CapabilityMap, {
        evidenceScope: drawerEvidenceScope,
        overview: historicalOverview,
        routeState: {
          ...defaultCapabilityMapRouteState,
          lifecycle: 'historical',
          focusTarget: { kind: 'node', id: 'cap-pay' },
        },
      }),
    );

    expect(html).toContain('When Atlas found this change, 1 workflow item was going to break');
    expect(html).toContain('Current situation: 0 affected items are in an active workflow');
    expect(html).toContain('Past workflow version');
    expect(html).toContain('replaced by checkout-v2');
    expect(html).toContain('the earlier block has been cleared');
    expect(html).toContain('version-pay-old');
    expect(html).toContain('Inspect recorded capability');
    expect(capabilityIdentityIdForVersion(historicalOverview, 'version-pay-old')).toBe('cap-pay');
  });

  it('shows the exact broken request and polling evidence on the focused red map', () => {
    stubDrawerWindow();
    const runtimeOverview: CapabilityOverview = {
      ...overview,
      impact: {
        type: 'runtime-mismatch',
        id: 'runtime-mismatch-1',
        affectedEndpointCount: 2,
        affectedWorkflowCount: 1,
        affectedStepCount: 2,
        currentlyExposedWorkflowCount: 1,
        currentlyExposedStepCount: 2,
        incompleteAnalysisCount: 0,
        analysis: 'complete',
        recordedAt: '2026-09-04T15:00:01.000Z',
        lastSeenAt: '2026-09-04T15:00:02.000Z',
        occurrenceCount: 2,
        state: 'active',
        sources: [
          {
            capabilityIdentityId: 'cap-pay',
            capabilityVersionId: 'version-pay',
            serviceId: 'payments',
            operationId: 'takePayment',
          },
        ],
      },
      nodes: overview.nodes.map((node) =>
        node.capabilityIdentityId === 'cap-pay'
          ? {
              ...node,
              impact: {
                affected: true,
                isSource: true,
                affectedWorkflowCount: 1,
                usages: [
                  {
                    workflowId: 'checkout',
                    workflowName: 'Checkout',
                    workflowVersionId: 'checkout-v1',
                    workflowLifecycle: 'active' as const,
                    stepId: 'take-payment',
                    capabilityVersionId: 'version-pay',
                    reason: 'This call does not provide the required extraLettuce field.',
                    evidence: {
                      runtimeMismatchId: 'runtime-mismatch-1',
                      observationId: 'polling-observation-1',
                      capabilityVersionId: 'version-pay',
                      status: 400,
                      normalizedReason: 'required-field-missing' as const,
                      fieldPath: 'extraLettuce',
                      observedAt: '2026-09-04T15:00:02.000Z',
                      path: [],
                    },
                  },
                ],
              },
            }
          : node,
      ),
    };
    const html = renderToStaticMarkup(
      createElement(CapabilityMap, {
        evidenceScope: drawerEvidenceScope,
        overview: runtimeOverview,
        routeState: {
          ...defaultCapabilityMapRouteState,
          impactFocusType: 'runtime-mismatch',
          impactFocusId: 'runtime-mismatch-1',
          focusTarget: { kind: 'node', id: 'cap-pay' },
        },
      }),
    );

    expect(html).toContain('Broken request source: payments · takePayment');
    expect(html).toContain('2 endpoints');
    expect(html).toContain('Broken request source');
    expect(html).toContain('Polling observation');
    expect(html.match(/Polling observation/g)).toHaveLength(2);
    expect(html).toContain('polling-observation-1');
    expect(html).toContain('required field missing');
    expect(html).toContain('HTTP 400');
    expect(html).toContain('extraLettuce');
    expect(html).toContain('version-pay');
    expect(html).toContain('take-payment');
    expect(html).toContain('Affected');

    if (runtimeOverview.impact?.type !== 'runtime-mismatch') {
      throw new Error('Expected runtime mismatch impact');
    }
    const recoveredOverview: CapabilityOverview = {
      ...runtimeOverview,
      impact: {
        ...runtimeOverview.impact!,
        state: 'recovered',
        recoveredAt: '2026-09-04T15:00:03.000Z',
      },
      nodes: runtimeOverview.nodes.map((node) =>
        node.impact ? { ...node, impact: { ...node.impact, affected: false } } : node,
      ),
    };
    const recoveredHtml = renderToStaticMarkup(
      createElement(CapabilityMap, {
        evidenceScope: drawerEvidenceScope,
        overview: recoveredOverview,
        routeState: {
          ...defaultCapabilityMapRouteState,
          impactFocusType: 'runtime-mismatch',
          impactFocusId: 'runtime-mismatch-1',
          focusTarget: { kind: 'node', id: 'cap-pay' },
        },
      }),
    );

    expect(recoveredHtml).toContain('Recovered');
    expect(recoveredHtml).toContain('The live warning is cleared');
    expect(recoveredHtml).toContain('Earlier broken request source');
    expect(recoveredHtml).toContain('What was going to break');
    expect(recoveredHtml).toContain('previously affected');
    expect(recoveredHtml).toContain('Polling observation');
    expect(recoveredHtml).not.toContain(' is-affected');
    expect(recoveredHtml).not.toContain('What will break');
  });

  it('separates access denial from a retryable load failure', () => {
    const denied = renderToStaticMarkup(
      createElement(CapabilityMapResult, {
        remote: { status: 'error', message: capabilityMapAccessDeniedMessage },
        reload: vi.fn<() => void>(),
      }),
    );
    const failed = renderToStaticMarkup(
      createElement(CapabilityMapResult, {
        remote: { status: 'error', message: 'Request failed (500)' },
        reload: vi.fn<() => void>(),
      }),
    );

    expect(denied).toContain('Map access denied');
    expect(denied).not.toContain('Try again');
    expect(failed).toContain('Capability map could not be loaded');
    expect(failed).toContain('Try again');
  });

  it('shows map retry progress and a distinct refresh failure', () => {
    const retrying = renderToStaticMarkup(
      createElement(CapabilityMapResult, {
        remote: { status: 'loading', retrying: true },
        reload: vi.fn<() => void>(),
      }),
    );
    const failed = renderToStaticMarkup(
      createElement(CapabilityMapResult, {
        remote: { status: 'error', message: 'Request failed (500)', refreshFailure: true },
        reload: vi.fn<() => void>(),
      }),
    );

    expect(retrying).toContain('Retrying capability map…');
    expect(retrying).toContain('aria-busy="true"');
    expect(failed).toContain('Capability map refresh failed');
    expect(failed).toContain('Try again');
  });
});
