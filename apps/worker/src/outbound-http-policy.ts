import { StepActivityError } from '@atlas/runtime-ports';

export function assertOutboundUrlApproved(
  url: URL,
  policyHostnames: readonly string[],
  grantHostnames: readonly string[] | undefined,
): void {
  // This check enforces the admin-approved DNS name. Resolved-address restrictions remain the
  // customer execution plane's egress control so the intentional local mock hostname still works.
  const hostname = url.hostname.toLowerCase();
  const policy = new Set(policyHostnames.map((value) => value.toLowerCase()));
  const grant = grantHostnames
    ? new Set(grantHostnames.map((value) => value.toLowerCase()))
    : undefined;
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !policy.has(hostname) ||
    (grant !== undefined && !grant.has(hostname))
  ) {
    throw new StepActivityError('ExecutionHostNotApproved');
  }
}

export function assertDownstreamResponseUrl(response: Response, requestedUrl: URL): void {
  if (response.status >= 300 && response.status < 400) {
    throw new StepActivityError('DownstreamRedirectDenied');
  }
  if (response.redirected) {
    throw new StepActivityError('DownstreamRedirectDenied');
  }
  if (!response.url) return;
  try {
    if (new URL(response.url).href !== requestedUrl.href) {
      throw new StepActivityError('DownstreamRedirectDenied');
    }
  } catch (error) {
    if (error instanceof StepActivityError) throw error;
    throw new StepActivityError('DownstreamRedirectDenied');
  }
}
