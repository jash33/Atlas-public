import type { WorkflowLifecycleStatus } from './catalog.js';

export const workflowLifecycleLabels: Record<WorkflowLifecycleStatus, string> = {
  draft: 'Draft',
  testing: 'Testing',
  'awaiting-approval': 'Awaiting approval',
  'approved-inactive': 'Approved inactive',
  active: 'Active',
  blocked: 'Blocked',
  'action-required': 'Action required',
};

export function formatWorkflowDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}
