import { describe, expect, it } from 'vite-plus/test';

import {
  canInspectDiagramNode,
  closeCapabilityDrawer,
  openCapabilityDrawer,
} from './diagram-drawer.js';

describe('capability diagram drawer', () => {
  it('opens a capability node by exact capabilityVersionId and restores focus on close', () => {
    const opened = openCapabilityDrawer({
      stepId: 'load-payment',
      kind: 'capabilityCall',
      capabilityVersionId: 'payment.get@v1',
    });

    expect(opened).toEqual({
      capabilityVersionId: 'payment.get@v1',
      restoreFocusStepId: 'load-payment',
    });

    expect(closeCapabilityDrawer(opened)).toEqual({
      capabilityVersionId: null,
      restoreFocusStepId: 'load-payment',
    });
  });

  it('carries the invoking step mappings into the capability drawer', () => {
    const mappings = { paymentId: { source: 'input', path: ['paymentId'] } };
    expect(
      openCapabilityDrawer(
        {
          stepId: 'load-payment',
          kind: 'capabilityCall',
          capabilityVersionId: 'payment.get@v1',
        },
        mappings,
      ),
    ).toEqual({
      capabilityVersionId: 'payment.get@v1',
      restoreFocusStepId: 'load-payment',
      inputMappings: mappings,
    });
  });

  it('does not invent capability evidence for terminal or unpinned nodes', () => {
    expect(
      canInspectDiagramNode({
        kind: 'terminal',
        capabilityVersionId: 'payment.get@v1',
      }),
    ).toBe(false);
    expect(
      openCapabilityDrawer({
        stepId: 'completed',
        kind: 'terminal',
        capabilityVersionId: null,
      }),
    ).toEqual({ capabilityVersionId: null, restoreFocusStepId: null });
    expect(
      canInspectDiagramNode({
        kind: 'capabilityCall',
        capabilityVersionId: null,
      }),
    ).toBe(false);
  });
});
