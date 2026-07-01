import { MailService } from './mail.service';
import sgMail from '@sendgrid/mail';

jest.mock('@sendgrid/mail', () => ({
  __esModule: true,
  default: {
    setApiKey: jest.fn(),
    send: jest.fn().mockResolvedValue(undefined),
  },
}));

describe('MailService — événements', () => {
  let service: MailService;
  const send = (sgMail as any).send as jest.Mock;

  beforeEach(() => {
    send.mockClear();
    service = new MailService();
  });

  it('sendEventModerationEmail envoie un mail contenant le titre, l’affiche et les liens', async () => {
    await service.sendEventModerationEmail({
      to: 'team@vybe.app',
      title: 'Soirée Test',
      description: 'desc',
      startDate: new Date('2030-01-01T20:00:00Z'),
      endDate: new Date('2030-01-01T23:00:00Z'),
      location: 'Kinshasa',
      gpsLat: null,
      gpsLng: null,
      category: 'CONCERT',
      dressCode: null,
      purchaseDeadline: new Date('2030-01-01T18:00:00Z'),
      creatorLabel: 'user-123',
      posterUrl: 'https://cdn/affiche.png',
      totalCapacity: 50000,
      ticketCategories: [
        {
          name: 'VIP',
          price: 100,
          ticketDesignUrl: 'https://cdn/vip.png',
          totalStock: 500,
        },
      ],
      approveUrl: 'https://api/events/moderate?token=t&decision=approve',
      rejectUrl: 'https://api/events/moderate?token=t&decision=reject',
    });

    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0];
    expect(msg.to).toBe('team@vybe.app');
    expect(msg.html).toContain('Soirée Test');
    expect(msg.html).toContain('https://cdn/affiche.png');
    expect(msg.html).toContain('decision=approve');
    expect(msg.html).toContain('decision=reject');
    expect(msg.html).toContain('VIP');
    expect(msg.html).toContain('50000');
    expect(msg.html).toContain('500');
  });

  it('sendEventDecisionEmail (validé) mentionne la validation', async () => {
    await service.sendEventDecisionEmail('u@x.com', 'Soirée Test', true);
    const msg = send.mock.calls[0][0];
    expect(msg.to).toBe('u@x.com');
    expect(msg.html).toContain('Soirée Test');
    expect(msg.subject.toLowerCase()).toContain('validé');
  });

  it('sendEventDecisionEmail (refusé) mentionne le refus', async () => {
    await service.sendEventDecisionEmail('u@x.com', 'Soirée Test', false);
    const msg = send.mock.calls[0][0];
    expect(msg.subject.toLowerCase()).toContain('refus');
  });
});
