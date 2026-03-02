import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendMailMock = vi.fn();
const createTransportMock = vi.fn(() => ({
  sendMail: (...args: unknown[]) => sendMailMock(...args),
}));
const fetchMock = vi.fn();

vi.mock('nodemailer', () => ({
  default: {
    createTransport: (...args: unknown[]) => (createTransportMock as any)(...args),
  },
  createTransport: (...args: unknown[]) => (createTransportMock as any)(...args),
}));

vi.mock('undici', () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
}));

describe('notifyService', () => {
  beforeEach(async () => {
    vi.resetModules();
    sendMailMock.mockReset();
    createTransportMock.mockClear();
    fetchMock.mockReset();

    const { config } = await import('../config.js');
    config.notifyCooldownSec = 300;
    config.webhookEnabled = false;
    config.webhookUrl = '';
    config.barkEnabled = false;
    config.barkUrl = '';
    config.serverChanEnabled = false;
    config.serverChanKey = '';
    config.smtpEnabled = true;
    config.smtpHost = 'smtp.example.com';
    config.smtpPort = 465;
    config.smtpSecure = true;
    config.smtpUser = 'demo-user';
    config.smtpPass = 'demo-pass';
    config.smtpFrom = 'sender@example.com';
    config.smtpTo = 'receiver@example.com';
  });

  it('bypasses cooldown when bypassThrottle is enabled', async () => {
    sendMailMock.mockResolvedValue({ accepted: ['receiver@example.com'] });
    const { sendNotification } = await import('./notifyService.js');

    await (sendNotification as any)('测试通知', 'same-message', 'info', { bypassThrottle: true });
    await (sendNotification as any)('测试通知', 'same-message', 'info', { bypassThrottle: true });

    expect(sendMailMock).toHaveBeenCalledTimes(2);
  });

  it('throws when strict delivery is required and no channels are enabled', async () => {
    const { config } = await import('../config.js');
    config.smtpEnabled = false;

    const { sendNotification } = await import('./notifyService.js');
    await expect(
      (sendNotification as any)('测试通知', 'message', 'info', {
        requireChannel: true,
        throwOnFailure: true,
      }),
    ).rejects.toThrow('未启用任何通知渠道');
  });

  it('throws when strict delivery is required and all channel sends fail', async () => {
    sendMailMock.mockRejectedValue(new Error('smtp auth failed'));
    const { sendNotification } = await import('./notifyService.js');

    await expect(
      (sendNotification as any)('测试通知', 'message', 'info', {
        bypassThrottle: true,
        throwOnFailure: true,
      }),
    ).rejects.toThrow(/smtp auth failed|通知发送失败/);
  });

  it('includes failed channel details when all enabled channels fail', async () => {
    const { config } = await import('../config.js');
    config.webhookEnabled = true;
    config.webhookUrl = 'https://webhook.example.com/notify';
    config.barkEnabled = true;
    config.barkUrl = 'https://api.day.app/mock-key';
    config.smtpEnabled = false;

    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
      });

    const { sendNotification } = await import('./notifyService.js');

    await expect(
      (sendNotification as any)('测试通知', 'message', 'info', {
        bypassThrottle: true,
        throwOnFailure: true,
      }),
    ).rejects.toThrow(/webhook|bark|Webhook 响应状态|Bark 响应状态/i);
  });

  it('includes local time and utc time labels in smtp payload', async () => {
    sendMailMock.mockResolvedValue({ accepted: ['receiver@example.com'] });
    const { sendNotification } = await import('./notifyService.js');

    await sendNotification('测试通知', 'message', 'info', { bypassThrottle: true });

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const payload = sendMailMock.mock.calls[0]?.[0] as { text?: string };
    expect(payload?.text || '').toContain('Local Time:');
    expect(payload?.text || '').toContain('UTC Time:');
  });
});
