import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vite-plus/test';

const capabilitiesPage = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'CapabilitiesPage.tsx'),
  'utf8',
);
const connectSourcePanel = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'ConnectSourcePanel.tsx'),
  'utf8',
);
const operationEvidenceDrawer = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'OperationEvidenceDrawer.tsx'),
  'utf8',
);
const capabilityMap = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'CapabilityMap.tsx'),
  'utf8',
);
const shellCss = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../shell.css'),
  'utf8',
);
const capabilityMonitoring = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'CapabilityMonitoring.tsx'),
  'utf8',
);

describe('capability catalog presentation', () => {
  it('replaces the catalog with the source connection flow and provides a way back', () => {
    expect(connectSourcePanel).toContain('Back to catalog');
    expect(capabilitiesPage).toMatch(
      /if \(connectOpen\) \{\s*return \(\s*<div className="capability-view-content">\s*<ConnectSourcePanel/,
    );
  });

  it('centers the capability drawer close mark geometrically instead of using font metrics', () => {
    expect(operationEvidenceDrawer).toContain(
      '<span aria-hidden="true" className="cat-drawer-close-icon" />',
    );
    expect(shellCss).toMatch(
      /\.cat-drawer-close-icon::before[\s\S]*left:\s*50%;[\s\S]*top:\s*50%;/,
    );
    expect(shellCss).toContain('translate(-50%, -50%) rotate(45deg)');
    expect(shellCss).toContain('translate(-50%, -50%) rotate(-45deg)');
  });

  it('separates simulated break status, impact, workflows, and actions', () => {
    expect(capabilityMap).toContain('className="cap-map-simulation-result"');
    expect(capabilityMap).toContain('className="cap-map-simulation-notice"');
    expect(capabilityMap).toContain('className="cap-map-simulation-workflows"');
    expect(capabilityMap).toContain('Clear Simulated Break');
    expect(shellCss).toMatch(/\.cap-map-simulation-result \{[\s\S]*?gap: 14px;/);
    expect(shellCss).toMatch(/\.cap-map-simulation-workflows ul \{[\s\S]*?gap: 6px;/);
  });

  it('renders simulated map nodes and connections with a dramatic red treatment', () => {
    expect(capabilityMap).toContain("' is-simulated-break'");
    expect(capabilityMap).toContain("' is-simulating'");
    expect(shellCss).toContain('--simulation-red: #a94f47;');
    expect(shellCss).toContain('--simulation-red-soft: #f3e3e0;');
    expect(shellCss).toMatch(
      /\.cap-map-svg-node\.is-simulated-break rect \{[\s\S]*?fill: var\(--simulation-red-soft\);[\s\S]*?stroke-width: 3px;/,
    );
    expect(shellCss).toMatch(
      /\.cap-map-edge\.is-simulated-break path \{[\s\S]*?stroke: var\(--simulation-red\);[\s\S]*?stroke-width: 4px;/,
    );
  });

  it('renders an active runtime break source in red even without affected workflow calls', () => {
    expect(capabilityMap).toContain("' is-broken-source'");
    expect(shellCss).toMatch(
      /\.cap-map-svg-node\.is-broken-source rect \{[\s\S]*?fill: var\(--danger-soft\);[\s\S]*?stroke: var\(--danger\);[\s\S]*?stroke-width: 3px;/,
    );
  });

  it('separates map search, display options, and investigation actions', () => {
    expect(capabilityMap).toContain('className="cap-map-tool-search"');
    expect(capabilityMap).toContain('className="cap-map-tool-options"');
    expect(capabilityMap).toContain('className="cap-map-tool-footer"');
    expect(capabilityMap).toContain('className="cap-map-tool-actions"');
    expect(shellCss).toMatch(
      /\.cap-map-tool-options \{[\s\S]*?grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/,
    );
    expect(shellCss).toMatch(/\.cap-map-tool-search \{[\s\S]*?padding: 16px 18px;/);
  });

  it('keeps the fitted camera stable across map view state updates', () => {
    expect(capabilityMap).toContain(
      'const fittedView = useMemo(() => capabilityMapFitView(layout), [layout]);',
    );
    expect(capabilityMap).not.toMatch(/const fittedView = capabilityMapFitView\(layout\);/);
  });

  it('places Burger Town monitoring in a demo-only Evidence Monitoring section', () => {
    expect(capabilitiesPage).toContain('import { CapabilityMonitoringPanel }');
    expect(capabilitiesPage).toMatch(/<div className="cat">\s*<CapabilityTabs active=\{view\}/);
    expect(capabilitiesPage).toMatch(
      /view === 'evidence'[\s\S]*?<section className="ec-demo-monitoring"[\s\S]*?Demo only[\s\S]*?<CapabilityMonitoringPanel[\s\S]*?<\/section>[\s\S]*?<EvidenceMonitoringPrototype/,
    );
    expect(capabilitiesPage).toContain('<CapabilityMapPage />');
    expect(capabilitiesPage).toContain('<CapabilityArchitecturePage />');
    expect(capabilitiesPage).toContain('<CapabilityCatalogPage />');
    expect(capabilityMap).not.toContain('import { CapabilityMonitoringPanel }');
  });

  it('uses one full-width capability shell for all three views', () => {
    expect(shellCss).toMatch(
      /\.cat \{[\s\S]*?box-sizing: border-box;[\s\S]*?max-width: 1400px;[\s\S]*?width: 100%;/,
    );
    expect(shellCss).toMatch(
      /\.capability-view-content \{[\s\S]*?min-width: 0;[\s\S]*?width: 100%;/,
    );
  });

  it('reserves the viewport scrollbar gutter when capability tabs differ in height', () => {
    expect(shellCss).toMatch(/html \{[\s\S]*?scrollbar-gutter: stable;/);
  });

  it('shows orange monitoring actions, transition progress, and successful poll feedback', () => {
    expect(capabilityMonitoring).toContain('className="cap-monitoring-action"');
    expect(capabilityMonitoring).toContain('className="wf-draft-spinner"');
    expect(capabilityMonitoring).toContain('cap-monitoring-poll-light');
    expect(shellCss).toMatch(
      /\.cap-monitoring-action \{[\s\S]*?background: var\(--accent\);[\s\S]*?color: var\(--on-accent\);/,
    );
    expect(shellCss).toMatch(
      /\.cap-monitoring-poll-light\.is-successful \{[\s\S]*?animation: cap-monitoring-poll-success 620ms ease-out;/,
    );
    expect(shellCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.cap-monitoring-poll-light\.is-successful \{[\s\S]*?animation: none;/,
    );
  });
});
