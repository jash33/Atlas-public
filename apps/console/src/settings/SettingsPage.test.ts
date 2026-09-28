import { createElement, type ReactElement } from 'react';
import { afterEach, expect, it, vi } from 'vite-plus/test';

import { parseSurfaceHash } from '../shell/router.js';
import { SettingsSectionLink } from './SettingsPage.js';

afterEach(() => vi.unstubAllGlobals());

it.each(['organization', 'memberships', 'environments', 'secrets', 'hosts'])(
  'keeps Settings open when navigating to %s',
  (section) => {
    const location = { hash: '#/settings' };
    const scrollIntoView = vi.fn<() => void>();
    const getElementById = vi.fn<(id: string) => { scrollIntoView: typeof scrollIntoView }>(() => ({
      scrollIntoView,
    }));
    vi.stubGlobal('document', { getElementById });
    const element: ReactElement<{ href?: string; onClick?: () => void }> = SettingsSectionLink({
      target: `settings-${section}`,
      children: createElement('span', null, section),
    });
    element.props.onClick?.();
    // Follow an anchor's default navigation, as a browser does after a click.
    if (element.props.href) location.hash = element.props.href;
    expect(parseSurfaceHash(location.hash)).toBe('settings');
    expect(getElementById).toHaveBeenCalledWith(`settings-${section}`);
    expect(scrollIntoView).toHaveBeenCalledOnce();
  },
);
