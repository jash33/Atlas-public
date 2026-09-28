import * as capabilities from '../content/capabilities.md';
import * as workflows from '../content/workflows.md';
import * as apiChanges from '../content/api-changes.md';
import * as selfHost from '../content/self-host.md';
import * as sso from '../../../../docs/CUSTOMER_SSO_INSTALL.md';
import * as roles from '../../../../docs/customer-roles.md';

export const guides = [
  {
    slug: 'concepts/capabilities',
    title: 'Capabilities',
    section: 'Core concepts',
    description:
      'Understand the API actions Atlas can use, how to connect them, and what approval means.',
    content: capabilities,
  },
  {
    slug: 'concepts/workflows',
    title: 'Workflows and runs',
    section: 'Core concepts',
    description: 'Connect approved actions into a reviewed plan, then follow each execution.',
    content: workflows,
  },
  {
    slug: 'concepts/api-changes',
    title: 'API changes',
    section: 'Core concepts',
    description:
      'Find affected workflows and review a replacement when a connected contract changes.',
    content: apiChanges,
  },
  {
    slug: 'self-host',
    title: 'Self-hosting',
    section: 'Installation',
    description:
      'Choose the local workflow evaluation or the customer web and sign-in installation.',
    content: selfHost,
  },
  {
    slug: 'sso-installation',
    title: 'Company sign-in (SSO)',
    section: 'Installation',
    description:
      'Set up Microsoft Entra ID, Google Workspace, or Okta and approve the first administrator.',
    content: sso,
  },
  {
    slug: 'customer-roles',
    title: 'Roles and access',
    section: 'Administration',
    description: 'Understand Author, Operator, and Admin permissions and how access is granted.',
    content: roles,
  },
];

export const sections = ['Core concepts', 'Installation', 'Administration'];
