import { EventsController } from './events.controller';

describe('EventsController', () => {
  let controller: EventsController;
  let events: any;
  let moderation: any;

  beforeEach(() => {
    events = { createEvent: jest.fn().mockResolvedValue({ eventId: 'evt-1' }) };
    moderation = { moderate: jest.fn().mockResolvedValue({ message: 'ok' }) };
    controller = new EventsController(events, moderation);
  });

  it('create délègue à EventsService avec req.user.sub', async () => {
    const req = { user: { sub: 'user-1', role: 'USER' } };
    await controller.create(req as any, { title: 'x' } as any);
    expect(events.createEvent).toHaveBeenCalledWith('user-1', { title: 'x' });
  });

  it('moderatePost délègue à EventModerationService', async () => {
    await controller.moderatePost({ token: 't', decision: 'approve' } as any);
    expect(moderation.moderate).toHaveBeenCalledWith('t', 'approve');
  });

  it('moderatePage renvoie une page HTML contenant le token et la décision', () => {
    const html = controller.moderatePage('t', 'approve');
    expect(html).toContain('approve');
    expect(html).toContain('t');
    expect(html.toLowerCase()).toContain('<form');
  });
});
