import { afterEach, describe, expect, it, vi } from 'vitest';
import { MatrixSendError, SynapseDeliveryClient } from '../../src/matrix/client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SynapseDeliveryClient', () => {
  it('treats malformed successful responses as retryable with a stable transaction id', async () => {
    const fetchMock = vi.fn((_input: Parameters<typeof fetch>[0]) =>
      Promise.resolve(
        new Response('{"event_id":', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new SynapseDeliveryClient('https://example.test', 100);
    const params = {
      accessToken: 'test-token',
      homeserverUrl: 'https://example.test',
      roomId: '!room:example.test',
      body: 'progress',
      deliveryKey: 'run-1:4:!room:example.test',
    };

    await expect(client.sendMessage(params)).rejects.toEqual(
      expect.objectContaining<Partial<MatrixSendError>>({
        name: 'MatrixSendError',
        status: 200,
        retryable: true,
      }),
    );
    await expect(client.sendMessage(params)).rejects.toMatchObject({ retryable: true });

    const requestUrls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(requestUrls).toEqual([requestUrls[0], requestUrls[0]]);
    expect(requestUrls[0]).toContain(
      `/send/m.room.message/${encodeURIComponent(params.deliveryKey)}`,
    );
  });

  it('normalizes response-body transport failures as retryable', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError('terminated'));
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const send = new SynapseDeliveryClient('https://example.test', 100).sendMessage({
      accessToken: 'test-token',
      homeserverUrl: 'https://example.test',
      roomId: '!room:example.test',
      body: 'progress',
      deliveryKey: 'run-1:4:!room:example.test',
    });

    await expect(send).rejects.toEqual(
      expect.objectContaining<Partial<MatrixSendError>>({
        name: 'MatrixSendError',
        status: 0,
        retryable: true,
      }),
    );
  });
});
