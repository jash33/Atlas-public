import { useRef, useState } from 'react';

import {
  changeBurgerTownMonitoring,
  useBurgerTownMonitoring,
  type BurgerTownMonitoringStatus,
} from './data.js';
import { CapabilityMonitoring, CapabilityMonitoringNotice } from './CapabilityMonitoring.js';

export function CapabilityMonitoringPanel({
  organizationId,
  environmentId,
  bearerToken,
}: {
  organizationId: string;
  environmentId: string;
  bearerToken: string;
}) {
  const monitoring = useBurgerTownMonitoring(organizationId, environmentId, bearerToken);
  const [action, setAction] = useState<'start' | 'stop' | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const actionSequence = useRef(0);

  const changeMonitoring = async (nextAction: 'start' | 'stop') => {
    const sequence = ++actionSequence.current;
    setAction(nextAction);
    setErrorMessage(null);
    try {
      await changeBurgerTownMonitoring(nextAction, { organizationId, environmentId }, bearerToken);
      if (sequence === actionSequence.current) monitoring.reload();
    } catch (error) {
      if (sequence === actionSequence.current) {
        setErrorMessage(error instanceof Error ? error.message : 'Monitoring could not be changed');
      }
    } finally {
      if (sequence === actionSequence.current) setAction(null);
    }
  };

  if (monitoring.remote.status === 'error') {
    return (
      <CapabilityMonitoringNotice
        message={monitoring.remote.message}
        onRetry={monitoring.reload}
        {...(monitoring.remote.refreshFailure ? { refreshFailure: true } : {})}
        state="error"
      />
    );
  }
  if (monitoring.remote.status === 'loading') {
    return (
      <CapabilityMonitoringNotice
        onRetry={monitoring.reload}
        {...(monitoring.remote.retrying ? { retrying: true } : {})}
        state="loading"
      />
    );
  }

  const status: BurgerTownMonitoringStatus = action
    ? {
        ...monitoring.remote.data,
        state: action === 'start' ? 'starting' : 'stopping',
      }
    : monitoring.remote.data;
  return (
    <>
      <CapabilityMonitoring
        onStart={() => void changeMonitoring('start')}
        onStop={() => void changeMonitoring('stop')}
        status={status}
      />
      {errorMessage ? (
        <p className="cap-monitoring-error" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </>
  );
}
