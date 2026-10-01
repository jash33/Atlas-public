import { describe, expect, it, vi } from 'vitest';

import { StepActivityError } from '@atlas/runtime-ports';

import { createSlackCapabilityActivity, loadSlackCapabilityBinding } from './slack-connector.js';

describe('Slack capability runtime binding', () => {
  it('loads the current governed Slack operation from the Atlas catalog', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        capabilities: [
          {
            capabilityVersionId: 'slack-generated-version',
            identity: { serviceId: 'slack', operationId: 'chat_postMessage' },
            annotation: { secretAlias: 'SLACK_BOT_TOKEN' },
            hostPolicy: { approvedHostnames: ['slack.com'] },
          },
        ],
      }),
    );

    await expect(
      loadSlackCapabilityBinding({
        backendUrl: 'http://backend:4000',
        organizationId: 'org_atlas',
        environmentId: 'official-test',
        fetch: fetchImplementation,
      }),
    ).resolves.toEqual({
      capabilityVersionId: 'slack-generated-version',
      secretAlias: 'SLACK_BOT_TOKEN',
      approvedHostnames: ['slack.com'],
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      'http://backend:4000/v1/capabilities?organizationId=org_atlas&environmentId=official-test',
      { signal: expect.any(AbortSignal) },
    );
  });

  it('resolves the credential inside the worker and invokes Slack without returning it', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ok: true,
        channel: 'C_TEST',
        ts: '1710000000.000001',
        message: { text: 'Hello from Atlas' },
      }),
    );
    const getSecret = vi.fn<() => Promise<string>>().mockResolvedValue('xoxb-worker-held-token');
    const activity = createSlackCapabilityActivity({
      binding: {
        capabilityVersionId: 'slack-generated-version',
        secretAlias: 'SLACK_BOT_TOKEN',
        approvedHostnames: ['slack.com'],
      },
      baseUrl: 'https://slack.com',
      secretProvider: { getSecret },
      fetch: fetchImplementation,
    });

    const result = await activity.invokeStep({
      capabilityVersionId: 'slack-generated-version',
      stepId: 'notify-team',
      input: {
        channel: 'C_TEST',
        text: 'Hello from Atlas',
        idempotencyKey: 'run-1-notify',
      },
      approvedHostnames: ['slack.com'],
    });

    expect(getSecret).toHaveBeenCalledWith('SLACK_BOT_TOKEN');
    expect(fetchImplementation).toHaveBeenCalledWith('https://slack.com/api/chat.postMessage', {
      signal: expect.any(AbortSignal),
      method: 'POST',
      redirect: 'manual',
      headers: {
        authorization: 'Bearer xoxb-worker-held-token',
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        channel: 'C_TEST',
        text: 'Hello from Atlas',
        client_msg_id: 'run-1-notify',
      }),
    });
    expect(JSON.stringify(result)).not.toContain('xoxb-worker-held-token');
  });

  it('normalizes a Slack API rejection for the standard runtime failure path', async () => {
    const activity = createSlackCapabilityActivity({
      binding: {
        capabilityVersionId: 'slack-generated-version',
        secretAlias: 'SLACK_BOT_TOKEN',
        approvedHostnames: ['slack.com'],
      },
      baseUrl: 'https://slack.com',
      secretProvider: {
        async getSecret() {
          return 'xoxb-worker-held-token';
        },
      },
      fetch: async () => Response.json({ ok: false, error: 'channel_not_found' }),
    });

    await expect(
      activity.invokeStep({
        capabilityVersionId: 'slack-generated-version',
        stepId: 'notify-team',
        input: { channel: 'missing', text: 'Hello', idempotencyKey: 'run-1-notify' },
        approvedHostnames: ['slack.com'],
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<StepActivityError>>({
        type: 'Slack_channel_not_found',
      }),
    );
  });

  it('rejects an unapproved final URL returned by the HTTP client', async () => {
    const response = Response.json({
      ok: true,
      channel: 'C_TEST',
      ts: '1710000000.000001',
      message: { text: 'Hello from Atlas' },
    });
    Object.defineProperty(response, 'url', {
      value: 'https://metadata.google.internal/latest',
    });
    const activity = createSlackCapabilityActivity({
      binding: {
        capabilityVersionId: 'slack-generated-version',
        secretAlias: 'SLACK_BOT_TOKEN',
        approvedHostnames: ['slack.com'],
      },
      baseUrl: 'https://slack.com',
      secretProvider: {
        async getSecret() {
          return 'xoxb-worker-held-token';
        },
      },
      fetch: async () => response,
    });

    await expect(
      activity.invokeStep({
        capabilityVersionId: 'slack-generated-version',
        stepId: 'notify-team',
        input: { channel: 'C_TEST', text: 'Hello', idempotencyKey: 'run-1-notify' },
        approvedHostnames: ['slack.com'],
      }),
    ).rejects.toMatchObject({ type: 'DownstreamRedirectDenied' });
  });
});
