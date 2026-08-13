import { afterEach, describe, expect, it, vi } from 'vitest';
import { MatrixSendError, SynapseDeliveryClient } from '../../src/matrix/client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SynapseDeliveryClient', () => {
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
