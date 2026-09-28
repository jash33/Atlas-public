import type { ReactNode } from 'react';

import type { Remote } from '../home/data.js';

export function RemoteView<T>({
  remote,
  reload,
  children,
}: {
  remote: Remote<T>;
  reload: () => void;
  children: (data: T) => ReactNode;
}) {
  if (remote.status === 'loading') {
    if (remote.retrying) {
      return (
        <div aria-busy="true" aria-live="polite" className="home-failure" role="status">
          <p>Trying to load the latest data…</p>
          <button aria-busy="true" disabled type="button">
            Retrying…
          </button>
        </div>
      );
    }
    return <p className="home-loading">Loading…</p>;
  }
  if (remote.status === 'error') {
    return (
      <div className="home-failure" role="alert">
        {remote.refreshFailure && <strong>Refresh failed</strong>}
        <p>{remote.message}</p>
        <button onClick={reload} type="button">
          Try again
        </button>
      </div>
    );
  }
  return <>{children(remote.data)}</>;
}
