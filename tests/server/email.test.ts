import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResendSender } from '../../src/server/email.js';

describe('createResendSender', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs to the Resend API with the expected shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const sendEmail = createResendSender('re_test_key', 'noreply@example.com');
    await sendEmail({ to: 'antonio@example.com', subject: 'Hello', html: '<p>hi</p>' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer re_test_key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'noreply@example.com',
          to: 'antonio@example.com',
          subject: 'Hello',
          html: '<p>hi</p>',
        }),
      }),
    );
  });

  it('throws a descriptive error, including the status code, on a non-ok response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 422 }) as unknown as typeof fetch;

    const sendEmail = createResendSender('re_test_key', 'noreply@example.com');

    await expect(
      sendEmail({ to: 'antonio@example.com', subject: 'Hello', html: '<p>hi</p>' }),
    ).rejects.toThrow(/422/);
  });
});
