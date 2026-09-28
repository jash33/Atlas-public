import { describe, expect, it, vi } from 'vitest';

import { StepActivityError } from '@atlas/runtime-ports';

import {
  createHubSpotCapabilityActivity,
  loadHubSpotCapabilityBinding,
} from './hubspot-connector.js';

describe('HubSpot capability runtime binding', () => {
  it('loads the current governed CRM operation from the Atlas catalog', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        capabilities: [
          {
            capabilityVersionId: 'hubspot-generated-version',
            identity: { serviceId: 'hubspot', operationId: 'createContact' },
            annotation: { secretAlias: 'HUBSPOT_ACCESS_TOKEN' },
            hostPolicy: { approvedHostnames: ['api.hubapi.com'] },
          },
        ],
      }),
    );

    await expect(
      loadHubSpotCapabilityBinding({
        backendUrl: 'http://backend:4000',
        organizationId: 'org_atlas',
        environmentId: 'official-test',
        fetch: fetchImplementation,
      }),
    ).resolves.toEqual({
      capabilityVersionId: 'hubspot-generated-version',
      secretAlias: 'HUBSPOT_ACCESS_TOKEN',
      approvedHostnames: ['api.hubapi.com'],
    });
  });

  it('resolves the credential inside the worker and invokes HubSpot without returning it', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        id: '101',
        properties: { email: 'sample@example.com', firstname: 'Ada', lastname: 'Lovelace' },
        createdAt: '2026-08-16T12:00:00.000Z',
        updatedAt: '2026-08-16T12:00:00.000Z',
        archived: false,
      }),
    );
    const getSecret = vi.fn<() => Promise<string>>().mockResolvedValue('pat-na1-worker-held-token');
    const activity = createHubSpotCapabilityActivity({
      binding: {
        capabilityVersionId: 'hubspot-generated-version',
        secretAlias: 'HUBSPOT_ACCESS_TOKEN',
        approvedHostnames: ['api.hubapi.com'],
      },
      baseUrl: 'https://api.hubapi.com',
      secretProvider: { getSecret },
      fetch: fetchImplementation,
    });

    const result = await activity.invokeStep({
      capabilityVersionId: 'hubspot-generated-version',
      stepId: 'create-contact',
      input: {
        email: 'sample@example.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
        idempotencyKey: 'contact-101',
      },
      approvedHostnames: ['api.hubapi.com'],
    });

    expect(getSecret).toHaveBeenCalledWith('HUBSPOT_ACCESS_TOKEN');
    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://api.hubapi.com/crm/v3/objects/contacts',
      {
        method: 'POST',
        redirect: 'manual',
        headers: {
          authorization: 'Bearer pat-na1-worker-held-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          properties: {
            email: 'sample@example.com',
            firstname: 'Ada',
            lastname: 'Lovelace',
          },
        }),
      },
    );
    expect(JSON.stringify(result)).not.toContain('pat-na1-worker-held-token');
  });

  it('normalizes a HubSpot API rejection for the standard runtime failure path', async () => {
    const activity = createHubSpotCapabilityActivity({
      binding: {
        capabilityVersionId: 'hubspot-generated-version',
        secretAlias: 'HUBSPOT_ACCESS_TOKEN',
        approvedHostnames: ['api.hubapi.com'],
      },
      baseUrl: 'https://api.hubapi.com',
      secretProvider: {
        async getSecret() {
          return 'pat-na1-worker-held-token';
        },
      },
      fetch: async () =>
        Response.json({ category: 'VALIDATION_ERROR', message: 'Invalid email' }, { status: 400 }),
    });

    await expect(
      activity.invokeStep({
        capabilityVersionId: 'hubspot-generated-version',
        stepId: 'create-contact',
        input: { email: 'invalid', firstName: 'Ada', lastName: 'Lovelace', idempotencyKey: '1' },
        approvedHostnames: ['api.hubapi.com'],
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<StepActivityError>>({ type: 'HubSpot_VALIDATION_ERROR' }),
    );
  });

  it('rejects an unapproved final URL returned by the HTTP client', async () => {
    const response = Response.json({
      id: '101',
      properties: { email: 'sample@example.com', firstname: 'Ada', lastname: 'Lovelace' },
      createdAt: '2026-08-16T12:00:00.000Z',
      updatedAt: '2026-08-16T12:00:00.000Z',
      archived: false,
    });
    Object.defineProperty(response, 'url', {
      value: 'https://metadata.google.internal/latest',
    });
    const activity = createHubSpotCapabilityActivity({
      binding: {
        capabilityVersionId: 'hubspot-generated-version',
        secretAlias: 'HUBSPOT_ACCESS_TOKEN',
        approvedHostnames: ['api.hubapi.com'],
      },
      baseUrl: 'https://api.hubapi.com',
      secretProvider: {
        async getSecret() {
          return 'pat-na1-worker-held-token';
        },
      },
      fetch: async () => response,
    });

    await expect(
      activity.invokeStep({
        capabilityVersionId: 'hubspot-generated-version',
        stepId: 'create-contact',
        input: {
          email: 'sample@example.com',
          firstName: 'Ada',
          lastName: 'Lovelace',
          idempotencyKey: '1',
        },
        approvedHostnames: ['api.hubapi.com'],
      }),
    ).rejects.toMatchObject({ type: 'DownstreamRedirectDenied' });
  });
});
