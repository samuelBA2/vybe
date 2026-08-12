import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AgentService } from './agent.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { hashCode } from 'src/common/hash-code';
import { MAX_AGENTS_PER_EVENT } from 'src/common/constants';

describe('AgentService', () => {
  let service: AgentService;
  let prisma: {
    event: { findUnique: jest.Mock };
    agent: { findUnique: jest.Mock; create: jest.Mock; findMany: jest.Mock; update: jest.Mock; count: jest.Mock };
    ticket: { findUnique: jest.Mock; updateMany: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      event: { findUnique: jest.fn() },
      agent: {
        findUnique: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
      },
      ticket: { findUnique: jest.fn(), updateMany: jest.fn() },
    };
    service = new AgentService(prisma as unknown as PrismaService);
  });

  // ─── CreatAgent ───────────────────────────────────────────────────────────────
  describe('CreatAgent', () => {
    const dto = (over: Partial<any> = {}) => ({
      firstname: 'Ada',
      lastname: 'Lovelace',
      eventReferenceId: 'VYBE-8JGBLV',
      ...over,
    });

    it('référence URL ≠ body → 400, aucun accès DB', async () => {
      await expect(
        service.CreatAgent('user-1', 'VYBE-8JGBLV', dto({ eventReferenceId: 'VYBE-67XC6F' })),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.event.findUnique).not.toHaveBeenCalled();
      expect(prisma.agent.create).not.toHaveBeenCalled();
    });

    it('références égales à la casse/espaces près → passe la garde (URL normalisée)', async () => {
      prisma.event.findUnique.mockResolvedValue(null); // stoppe ensuite en 404
      await expect(
        service.CreatAgent('user-1', '  vybe-8jgblv  ', dto()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.event.findUnique).toHaveBeenCalled();
    });

    it('événement introuvable → 404, aucune création', async () => {
      prisma.event.findUnique.mockResolvedValue(null);
      await expect(
        service.CreatAgent('user-1', 'VYBE-8JGBLV', dto()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.agent.create).not.toHaveBeenCalled();
    });

    it('non-propriétaire de l’événement → 403, aucune création', async () => {
      prisma.event.findUnique.mockResolvedValue({ id: 'event-1', reference: 'VYBE-8JGBLV', createdById: 'someone-else' });
      await expect(
        service.CreatAgent('user-1', 'VYBE-8JGBLV', dto()),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.agent.create).not.toHaveBeenCalled();
    });

    it('événement plein (limite atteinte) → 409, aucune création', async () => {
      prisma.event.findUnique.mockResolvedValue({ id: 'event-1', reference: 'VYBE-8JGBLV', createdById: 'user-1' });
      prisma.agent.count.mockResolvedValue(MAX_AGENTS_PER_EVENT);
      await expect(
        service.CreatAgent('user-1', 'VYBE-8JGBLV', dto()),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.agent.count).toHaveBeenCalledWith({ where: { eventId: 'event-1', active: true } });
      expect(prisma.agent.create).not.toHaveBeenCalled();
    });

    it('créateur + références égales → crée l’agent et renvoie le code AG- en clair', async () => {
      prisma.event.findUnique.mockResolvedValue({ id: 'event-1', reference: 'VYBE-8JGBLV', createdById: 'user-1' });
      prisma.agent.count.mockResolvedValue(0); // événement pas encore plein
      prisma.agent.findUnique.mockResolvedValue(null); // code unique du 1er coup
      prisma.agent.create.mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'agent-1', firstname: data.firstname, lastname: data.lastname }),
      );

      const res = await service.CreatAgent('user-1', 'VYBE-8JGBLV', dto());

      // Code en clair au format AG-XXXXXXXX.
      expect(res.code).toMatch(/^AG-[A-Z2-9]{8}$/);
      // On stocke le hash du code exposé, rattaché au bon événement.
      expect(prisma.agent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            firstname: 'Ada',
            lastname: 'Lovelace',
            hashCode: hashCode(res.code),
            eventId: 'event-1',
          }),
        }),
      );
      expect(res.agent).toEqual({ id: 'agent-1', firstname: 'Ada', lastname: 'Lovelace' });
    });
  });

  // ─── listAgents ───────────────────────────────────────────────────────────────
  describe('listAgents', () => {
    it('événement introuvable → 404', async () => {
      prisma.event.findUnique.mockResolvedValue(null);
      await expect(service.listAgents('user-1', 'VYBE-8JGBLV')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-propriétaire → 403', async () => {
      prisma.event.findUnique.mockResolvedValue({ id: 'event-1', createdById: 'someone-else' });
      await expect(service.listAgents('user-1', 'VYBE-8JGBLV')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('propriétaire → renvoie les agents de l’événement', async () => {
      prisma.event.findUnique.mockResolvedValue({ id: 'event-1', createdById: 'user-1' });
      prisma.agent.findMany.mockResolvedValue([{ id: 'agent-1' }]);
      const res = await service.listAgents('user-1', 'VYBE-8JGBLV');
      expect(prisma.agent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { eventId: 'event-1' } }),
      );
      expect(res).toEqual([{ id: 'agent-1' }]);
    });
  });

  // ─── deleteAgent (révocation) ──────────────────────────────────────────────────
  describe('deleteAgent', () => {
    it('agent introuvable → 404', async () => {
      prisma.agent.findUnique.mockResolvedValue(null);
      await expect(service.deleteAgent('user-1', 'agent-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.agent.update).not.toHaveBeenCalled();
    });

    it('non-propriétaire de l’événement → 403, aucune révocation', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'agent-1', event: { createdById: 'someone-else' } });
      await expect(service.deleteAgent('user-1', 'agent-1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.agent.update).not.toHaveBeenCalled();
    });

    it('propriétaire → passe active=false', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'agent-1', event: { createdById: 'user-1' } });
      prisma.agent.update.mockResolvedValue({});
      await service.deleteAgent('user-1', 'agent-1');
      expect(prisma.agent.update).toHaveBeenCalledWith({
        where: { id: 'agent-1' },
        data: { active: false },
      });
    });
  });

  // ─── scan (Phase 4 : scan isolé) ───────────────────────────────────────────────
  describe('scan', () => {
    // Agent actif par défaut ; les tests le surchargent au besoin.
    const activeAgent = { id: 'agent-1', active: true };
    // Billet valide par défaut : UNUSED, non expiré, rattaché à event-1.
    const ticket = (over: Partial<any> = {}) => ({
      qrToken: 'qr-1',
      qrStatus: 'UNUSED',
      expiresAt: new Date(Date.now() + 3_600_000), // +1h
      scannedAt: null,
      ticketCategory: { eventId: 'event-1', name: 'VIP' },
      order: { user: { firstname: 'Ada', lastname: 'Lovelace' } },
      ...over,
    });

    it('agent révoqué (active=false) → 403, ne touche pas au billet', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'agent-1', active: false });
      await expect(service.scan('event-1', 'agent-1', 'qr-1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.ticket.findUnique).not.toHaveBeenCalled();
    });

    it('agent inexistant → 403', async () => {
      prisma.agent.findUnique.mockResolvedValue(null);
      await expect(service.scan('event-1', 'agent-1', 'qr-1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('billet introuvable → 404', async () => {
      prisma.agent.findUnique.mockResolvedValue(activeAgent);
      prisma.ticket.findUnique.mockResolvedValue(null);
      await expect(service.scan('event-1', 'agent-1', 'qr-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it("ISOLATION : billet d'un autre événement → 403, aucune transition", async () => {
      prisma.agent.findUnique.mockResolvedValue(activeAgent);
      prisma.ticket.findUnique.mockResolvedValue(ticket({ ticketCategory: { eventId: 'autre-event', name: 'VIP' } }));
      await expect(service.scan('event-1', 'agent-1', 'qr-1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.ticket.updateMany).not.toHaveBeenCalled();
    });

    it('billet expiré → 403', async () => {
      prisma.agent.findUnique.mockResolvedValue(activeAgent);
      prisma.ticket.findUnique.mockResolvedValue(ticket({ expiresAt: new Date(Date.now() - 1000) }));
      await expect(service.scan('event-1', 'agent-1', 'qr-1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.ticket.updateMany).not.toHaveBeenCalled();
    });

    it('billet annulé (CANCELLED) → 403', async () => {
      prisma.agent.findUnique.mockResolvedValue(activeAgent);
      prisma.ticket.findUnique.mockResolvedValue(ticket({ qrStatus: 'CANCELLED' }));
      await expect(service.scan('event-1', 'agent-1', 'qr-1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.ticket.updateMany).not.toHaveBeenCalled();
    });

    it('billet déjà scanné (USED) → 409', async () => {
      prisma.agent.findUnique.mockResolvedValue(activeAgent);
      prisma.ticket.findUnique.mockResolvedValue(
        ticket({ qrStatus: 'USED', scannedAt: new Date('2026-08-11T10:00:00.000Z') }),
      );
      await expect(service.scan('event-1', 'agent-1', 'qr-1')).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.ticket.updateMany).not.toHaveBeenCalled();
    });

    it('UNUSED → transition atomique USED + infos d’accès', async () => {
      prisma.agent.findUnique.mockResolvedValue(activeAgent);
      prisma.ticket.findUnique.mockResolvedValue(ticket());
      prisma.ticket.updateMany.mockResolvedValue({ count: 1 });

      const res = await service.scan('event-1', 'agent-1', 'qr-1');

      // Le verrou anti-double-scan : where filtre sur qrStatus UNUSED, data pose l'agent.
      expect(prisma.ticket.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { qrToken: 'qr-1', qrStatus: 'UNUSED' },
          data: expect.objectContaining({ qrStatus: 'USED', scannedByAgentId: 'agent-1' }),
        }),
      );
      expect(res).toEqual(
        expect.objectContaining({ category: 'VIP', holderName: 'Ada Lovelace' }),
      );
    });

    it('CONCURRENCE : updateMany count=0 (course perdue) → 409', async () => {
      prisma.agent.findUnique.mockResolvedValue(activeAgent);
      prisma.ticket.findUnique.mockResolvedValue(ticket()); // vu UNUSED au pré-contrôle…
      prisma.ticket.updateMany.mockResolvedValue({ count: 0 }); // …mais un autre scan a gagné
      await expect(service.scan('event-1', 'agent-1', 'qr-1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('porteur sans nom → holderName "Porteur inconnu"', async () => {
      prisma.agent.findUnique.mockResolvedValue(activeAgent);
      prisma.ticket.findUnique.mockResolvedValue(
        ticket({ order: { user: { firstname: null, lastname: null } } }),
      );
      prisma.ticket.updateMany.mockResolvedValue({ count: 1 });
      const res = await service.scan('event-1', 'agent-1', 'qr-1');
      expect(res.holderName).toBe('Porteur inconnu');
    });
  });
});
