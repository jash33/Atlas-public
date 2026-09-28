import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vite-plus/test';

import { CapabilityMonitoring, CapabilityMonitoringNotice } from './CapabilityMonitoring.js';

describe('CapabilityMonitoring', () => {
  it('omits the polling description and empty-target message without hiding status', () => {
    const html = renderToStaticMarkup(
      createElement(CapabilityMonitoring, {
        status: {
          state: 'unavailable',
          lastCompletedSweepAt: null,
          readinessMessage: 'Burger Town has no ready polling targets',
        },
        onStart: vi.fn<() => void>(),
        onStop: vi.fn<() => void>(),
      }),
    );
    expect(html).not.toContain('Burger Town has no ready polling targets');
    expect(html).not.toContain('Checks prepared Burger Town probes once per second');
    expect(html).toContain('Monitoring unavailable');
    expect(html).toContain('Last completed check:');
  });
  it('offers a way to cancel startup', () => {
    const html = renderToStaticMarkup(
      createElement(CapabilityMonitoring, {
        status: { state: 'starting', lastCompletedSweepAt: null, readinessMessage: null },
        onStart: vi.fn<() => void>(),
        onStop: vi.fn<() => void>(),
      }),
    );
    expect(html).toContain('Cancel startup');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('class="wf-draft-spinner"');
  });
  it.each([
    ['unavailable', 'Monitoring unavailable'],
    ['stopped', 'Monitoring stopped'],
    ['starting', 'Starting monitoring'],
    ['active', 'Monitoring active'],
    ['stopping', 'Stopping monitoring'],
  ] as const)('shows the %s state', (state, label) => {
    const html = renderToStaticMarkup(
      createElement(CapabilityMonitoring, {
        status: { state, lastCompletedSweepAt: null, readinessMessage: null },
        onStart: vi.fn<() => void>(),
        onStop: vi.fn<() => void>(),
      }),
    );

    expect(html).toContain(label);
    expect(html).not.toContain('Demo only');
    expect(html).toContain('Last completed check:');
    expect(html).toContain('No completed check reported');
  });

  it('offers Start monitoring Burger Town while stopped', () => {
    const html = renderToStaticMarkup(
      createElement(CapabilityMonitoring, {
        status: { state: 'stopped', lastCompletedSweepAt: null, readinessMessage: null },
        onStart: vi.fn<() => void>(),
        onStop: vi.fn<() => void>(),
      }),
    );

    expect(html).toContain('Start monitoring Burger Town');
    expect(html).toContain('class="cap-monitoring-action"');
    expect(html).not.toContain('Stop monitoring');
  });

  it('shows progress while monitoring stops', () => {
    const html = renderToStaticMarkup(
      createElement(CapabilityMonitoring, {
        status: { state: 'stopping', lastCompletedSweepAt: null, readinessMessage: null },
        onStart: vi.fn<() => void>(),
        onStop: vi.fn<() => void>(),
      }),
    );

    expect(html).toContain('Stopping monitoring…');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('class="wf-draft-spinner"');
    expect(html).toContain('disabled=""');
  });

  it('does not offer Start monitoring while setup is unavailable', () => {
    const html = renderToStaticMarkup(
      createElement(CapabilityMonitoring, {
        status: {
          state: 'unavailable',
          lastCompletedSweepAt: null,
          readinessMessage: 'Burger Town setup is incomplete',
        },
        onStart: vi.fn<() => void>(),
        onStop: vi.fn<() => void>(),
      }),
    );

    expect(html).toContain('Burger Town setup is incomplete');
    expect(html).not.toContain('Start monitoring');
  });

  it('offers Stop monitoring and the last completed check while active', () => {
    const html = renderToStaticMarkup(
      createElement(CapabilityMonitoring, {
        status: {
          state: 'active',
          lastCompletedSweepAt: '2026-09-04T15:00:01.000Z',
          readinessMessage: null,
        },
        onStart: vi.fn<() => void>(),
        onStop: vi.fn<() => void>(),
      }),
    );

    expect(html).toContain('Stop monitoring');
    expect(html).toContain('Last completed check');
    expect(html).toContain('cap-monitoring-poll-light is-active is-successful');
    expect(html).toContain('data-poll-completed-at="2026-09-04T15:00:01.000Z"');
  });

  it('keeps the monitoring card visible while checking its status', () => {
    const html = renderToStaticMarkup(
      createElement(CapabilityMonitoringNotice, { state: 'loading', onRetry: vi.fn<() => void>() }),
    );

    expect(html).toContain('class="cap-monitoring"');
    expect(html).toContain('Checking monitoring status');
    expect(html).toContain('Automatic status updates will begin');
  });

  it('shows monitoring retry progress and a distinct refresh failure', () => {
    const retrying = renderToStaticMarkup(
      createElement(CapabilityMonitoringNotice, {
        state: 'loading',
        retrying: true,
        onRetry: vi.fn<() => void>(),
      }),
    );
    const failed = renderToStaticMarkup(
      createElement(CapabilityMonitoringNotice, {
        state: 'error',
        refreshFailure: true,
        message: 'Request failed (500)',
        onRetry: vi.fn<() => void>(),
      }),
    );

    expect(retrying).toContain('Retrying monitoring status');
    expect(retrying).toContain('aria-busy="true"');
    expect(failed).toContain('Monitoring status refresh failed');
    expect(failed).toContain('Try again');
  });

  it('explains that automatic updates stop after a status error and offers retry', () => {
    const html = renderToStaticMarkup(
      createElement(CapabilityMonitoringNotice, {
        state: 'error',
        message: 'Request failed (500)',
        onRetry: vi.fn<() => void>(),
      }),
    );

    expect(html).toContain('class="cap-monitoring"');
    expect(html).toContain('Monitoring status could not be loaded');
    expect(html).toContain('Automatic status updates are paused');
    expect(html).toContain('Try again');
  });
});
