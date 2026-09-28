import type { BurgerTownMonitoringStatus } from './data.js';

const statusLabels: Record<BurgerTownMonitoringStatus['state'], string> = {
  unavailable: 'Monitoring unavailable',
  stopped: 'Monitoring stopped',
  starting: 'Starting monitoring',
  active: 'Monitoring active',
  stopping: 'Stopping monitoring',
};

export function CapabilityMonitoringNotice({
  state,
  message,
  onRetry,
  refreshFailure = false,
  retrying = false,
}: {
  state: 'loading' | 'error';
  message?: string;
  onRetry: () => void;
  refreshFailure?: boolean;
  retrying?: boolean;
}) {
  const failed = state === 'error';
  return (
    <section
      aria-busy={!failed || undefined}
      aria-label="Burger Town monitoring"
      className="cap-monitoring"
    >
      <div>
        <strong>
          {failed
            ? refreshFailure
              ? 'Monitoring status refresh failed'
              : 'Monitoring status could not be loaded'
            : retrying
              ? 'Retrying monitoring status'
              : 'Checking monitoring status'}
        </strong>
        {failed ? (
          <small className="cap-monitoring-error" role="alert">
            {message ? `${message} ` : ''}Automatic status updates are paused. Atlas will not try
            again until you select Try again.
          </small>
        ) : (
          <small>
            {retrying
              ? 'Atlas is trying to reconnect. Automatic status updates remain paused until it succeeds.'
              : 'Atlas is checking Burger Town. Automatic status updates will begin after it connects.'}
          </small>
        )}
      </div>
      {failed ? (
        <button onClick={onRetry} type="button">
          Try again
        </button>
      ) : null}
    </section>
  );
}

export function CapabilityMonitoring({
  status,
  onStart,
  onStop,
}: {
  status: BurgerTownMonitoringStatus;
  onStart: () => void;
  onStop: () => void;
}) {
  const pollCompleted = status.state === 'active' && status.lastCompletedSweepAt !== null;
  return (
    <section aria-label="Burger Town monitoring" className="cap-monitoring">
      <div>
        <div className="cap-monitoring-heading">
          <span
            aria-hidden="true"
            className={`cap-monitoring-poll-light${status.state === 'active' ? ' is-active' : ''}${pollCompleted ? ' is-successful' : ''}`}
            data-poll-completed-at={status.lastCompletedSweepAt ?? undefined}
            key={status.lastCompletedSweepAt ?? status.state}
          />
          <strong>{statusLabels[status.state]}</strong>
        </div>
        <small>
          Last completed check:{' '}
          {status.lastCompletedSweepAt ? (
            <time dateTime={status.lastCompletedSweepAt}>
              {new Date(status.lastCompletedSweepAt).toLocaleString()}
            </time>
          ) : (
            'No completed check reported'
          )}
        </small>
        {status.readinessMessage &&
        status.readinessMessage !== 'Burger Town has no ready polling targets' ? (
          <p role="alert">{status.readinessMessage}</p>
        ) : null}
      </div>
      {status.state === 'stopped' ? (
        <button className="cap-monitoring-action" onClick={onStart} type="button">
          Start monitoring Burger Town
        </button>
      ) : null}
      {status.state === 'active' || status.state === 'starting' ? (
        <button
          aria-busy={status.state === 'starting' || undefined}
          className="cap-monitoring-action"
          onClick={onStop}
          type="button"
        >
          {status.state === 'starting' ? (
            <span aria-hidden="true" className="wf-draft-spinner" />
          ) : null}
          {status.state === 'starting' ? 'Cancel startup' : 'Stop monitoring'}
        </button>
      ) : null}
      {status.state === 'stopping' ? (
        <button aria-busy="true" className="cap-monitoring-action" disabled type="button">
          <span aria-hidden="true" className="wf-draft-spinner" />
          Stopping monitoring…
        </button>
      ) : null}
    </section>
  );
}
