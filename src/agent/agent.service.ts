import { ConflictException, Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcrypt'
import { randomCode } from 'src/common/generate-code';
import { CreateAgentDto } from './dto/create-agent.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { hashCode } from 'src/common/hash-code';
import { MAX_AGENTS_PER_EVENT, PLATFORM_FEE_RATE, APP_TIMEZONE } from 'src/common/constants';
import { ScanDashboardResponseDto } from './dto/ScanDashboard.dto';

const round2 = (n: number) => Math.round(n* 100) / 100;

@Injectable()
export class AgentService {
  constructor(private readonly prisma: PrismaService) {}

  async CreatAgent(userId: string, reference : string, dto: CreateAgentDto){

    // Double sécurité : la référence de l'URL et celle du body doivent coïncider.
    // (le body est déjà trim + uppercase par le DTO ; on normalise l'URL de même)
    if (dto.eventReferenceId !== reference.trim().toUpperCase()) {
      throw new BadRequestException("La référence de l'URL et celle du body ne correspondent pas.");
    }

    const event = await this.prisma.event.findUnique({ where: { reference } });
    // si aucune ligne ne correspont l'evenement n'existe pas 
    if (!event) {throw new NotFoundException('Evenement Introuvable')};

    // Seul le créateur de l'événement peut lui ajouter des agents.
    if (event.createdById !== userId) throw new ForbiddenException("Vous n'êtes pas invité à gerer cet événement.");

    // Limite d'agents ACTIFS par événement : révoquer un agent (active=false)
    // libère un slot. Aligné sur le compteur de l'UI.
    const agentCount = await this.prisma.agent.count({ where: { eventId: event.id, active: true } });
    if (agentCount >= MAX_AGENTS_PER_EVENT) {
      throw new ConflictException(`Limite de ${MAX_AGENTS_PER_EVENT} agents atteinte pour cet événement.`);
    }

    const code = await this.generateUniqueCode(); // "AG-XXXXX" unique

    const agent = await this.prisma.agent.create({
      data: {
        firstname : dto.firstname,
        lastname : dto.lastname,
        hashCode: hashCode(code),
        eventId: event.id
      }
    });
    //Expose le code pour remettre à l'agent 
    return { agent: { id: agent.id, firstname: agent.firstname, lastname: agent.lastname }, code}
  }


  async listAgents(userId: string, reference: string) {
  
  const event = await this.prisma.event.findUnique({
    where: { reference },
  });
  if (!event) {
    throw new NotFoundException('Événement introuvable.');
  }
  if (event.createdById !== userId) {
    throw new ForbiddenException('Vous ne gérez pas cet événement.');
  }
  return this.prisma.agent.findMany({
    where: { eventId: event.id },
    select: {
      id: true,
      firstname: true,
      lastname: true,
      active: true,
      usedAt: true,
      createdAt: true,
    },
  });
}

  async deleteAgent(userId: string, agentId: string){
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      include: { event: true },
    })
    if (!agent){
      throw new NotFoundException('Agent introuvable.')
    }
    //remonte de l'agent → son event → son créateur.
    if (agent.event.createdById !== userId){
      throw new ForbiddenException('Vous ne gérez pas cet événement.')
    }
    return this.prisma.agent.update({
      where: { id: agentId},
      data: { active: false}
    })
  }

  async scan(eventId: string, agentId: string, qrToken: string){
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent || !agent.active) throw new ForbiddenException('Agent révoqué ou inexistant.')
    
    const ticket = await this.prisma.ticket.findUnique({ where: { qrToken },
    include: { ticketCategory: true, order: { include: { user: true } } },
  });
    if (!ticket) throw new NotFoundException("Ce billet n'appartient pas à votre événement.");

    if (ticket.ticketCategory.eventId !== eventId) throw new ForbiddenException("Ce billet n'appartient pas à votre événement.")

    if (ticket.expiresAt < new Date()) throw new ForbiddenException('Billet expiré')

    if (ticket.qrStatus === 'CANCELLED') throw new ForbiddenException('Billet déjà annulé.')
    // Date exposée en champ structuré (ISO) : le client la formate en heure locale.
    if (ticket.qrStatus === 'USED') throw new ConflictException({ message: 'Billet déjà scanné.', scannedAt: ticket.scannedAt?.toISOString() })

    const res = await this.prisma.ticket.updateMany({
      where: { qrToken, qrStatus: 'UNUSED' },
      data: { qrStatus: 'USED', scannedAt: new Date(), scannedByAgentId: agentId },
    });
    if (res.count !== 1) throw new ConflictException('Billet déjà scanné.');

    // firstname/lastname sont nullable : on filtre les valeurs manquantes
    // pour éviter un affichage "null null" à l'entrée.
    const holderName =
      [ticket.order.user.firstname, ticket.order.user.lastname]
        .filter(Boolean)
        .join(' ')
        .trim() || 'Porteur inconnu';

    return {
      status: "Billet validé !",
      category: ticket.ticketCategory.name,
      holderName,
    }
  }

  // Dashboard de scans réservé au créateur de l'événement (brique E).
  // Agrégation hybride : groupBy pour statuts/catégories/agents,
  // findMany léger des scannedAt (USED) pour la timeline horaire en JS.
  async getScanDashboard(userId: string, reference: string): Promise<ScanDashboardResponseDto> {
    const event = await this.prisma.event.findUnique({ where: { reference } });
    if (!event) throw new NotFoundException('Événement introuvable.');
    if (event.createdById !== userId) throw new ForbiddenException('Vous ne gérez pas cet événement.');

    const eventId = event.id;
    const eventFilter = { ticketCategory: { eventId } };

    // 1. Statuts globaux
    const statusGroups = await this.prisma.ticket.groupBy({
      by: ['qrStatus'],
      where: eventFilter,
      _count: true,
    });
    const countByStatus = (s: string): number =>
      statusGroups.find((g: any) => g.qrStatus === s)?._count ?? 0;
    const scanned = countByStatus('USED');
    const unused = countByStatus('UNUSED');
    const cancelled = countByStatus('CANCELLED');
    const total = scanned + unused + cancelled;
    const attended = scanned + unused;
    const entryRate = attended === 0 ? 0 : Math.round((scanned / attended) * 10000) / 10000;

    // 2. Par catégorie
    const categories = await this.prisma.ticketCategory.findMany({
      where: { eventId },
      select: { id: true, name: true, soldCount: true, totalStock: true},
    });
    const usedByCategory = await this.prisma.ticket.groupBy({
      by: ['ticketCategoryId'],
      where: { qrStatus: 'USED', ...eventFilter },
      _count: true,
    });
    const scannedForCat = (id: string): number =>
      usedByCategory.find((g: any) => g.ticketCategoryId === id)?._count ?? 0;

    // Agrégats de revenus (commandes PAID uniquement, future-proof pour la brique B)
    const categoryIds = categories.map((c) => c.id);
    const paidWhere = { paymentStatus: 'PAID' as const, ticketCategoryId: { in: categoryIds } };

    const financeAgg = await this.prisma.order.aggregate({
      where: paidWhere,
      _sum: { totalAmount: true, platformFee: true, organizerAmount: true, quantity: true },
      _count: true,
    });
    const revenueByCat = await this.prisma.order.groupBy({
      by: ['ticketCategoryId'],
      where: paidWhere,
      _sum: { totalAmount: true },
    });
    const revenueForCat = (id: string): number =>
      round2(revenueByCat.find((g: any) => g.ticketCategoryId === id)?._sum.totalAmount ?? 0);

    const byCategory = categories.map((c) => {
      const catScanned = scannedForCat(c.id);
      return {
        name: c.name,
        sold: c.soldCount,
        scanned: catScanned,
        remaining: c.totalStock === null ? null : c.totalStock - c.soldCount, // inventaire (null = illimité)
        awaitingCheckIn: c.soldCount - catScanned, // vendus pas encore scannés
        revenue: revenueForCat(c.id),
      };
    });

    // Capacité totale = la jauge annoncée sur l'événement (null = billetterie illimitée).
    const capacity = event.totalCapacity;

    // 3. Par agent
    const usedByAgent = await this.prisma.ticket.groupBy({
      by: ['scannedByAgentId'],
      where: { qrStatus: 'USED', ...eventFilter },
      _count: true,
    });
    const agents = await this.prisma.agent.findMany({
      where: { eventId },
      select: { id: true, firstname: true, lastname: true },
    });
    const agentName = (a: { firstname: string | null; lastname: string | null }): string =>
      [a.firstname, a.lastname].filter(Boolean).join(' ').trim() || 'Agent inconnu';
    const byAgent = usedByAgent
      .filter((g: any) => g.scannedByAgentId != null)
      .map((g: any) => {
        const agent = agents.find((a) => a.id === g.scannedByAgentId);
        return {
          agentId: g.scannedByAgentId as string,
          name: agent ? agentName(agent) : 'Agent inconnu',
          scanned: g._count as number,
        };
      });

    // 4. Timeline : bucketisation horaire AGRÉGÉE EN SQL (ne charge plus tous les
    // billets USED en mémoire — indispensable pour la billetterie illimitée).
    // Buckets calés sur l'HEURE LOCALE de la région (APP_TIMEZONE) : scannedAt est
    // un timestamp UTC naïf → on le réinterprète en UTC puis on le convertit dans
    // le fuseau applicatif avant de tronquer à l'heure. `hour` est donc une chaîne
    // locale SANS suffixe Z (heure murale de l'événement) ; le front l'affiche telle
    // quelle, sans reconvertir. Filtre servi par l'index Ticket[ticketCategoryId,qrStatus,scannedAt].
    const timelineRows = await this.prisma.$queryRaw<Array<{ hour: string; count: number }>>`
      SELECT to_char(
               date_trunc('hour', (t."scannedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TIMEZONE}),
               'YYYY-MM-DD"T"HH24:00:00'
             ) AS hour,
             COUNT(*)::int AS count
      FROM "Ticket" t
      JOIN "TicketCategory" tc ON tc."id" = t."ticketCategoryId"
      WHERE tc."eventId" = ${eventId}
        AND t."qrStatus"::text = 'USED'
        AND t."scannedAt" IS NOT NULL
      GROUP BY 1
      ORDER BY 1;`;
    const timeline = timelineRows.map((r) => ({ hour: r.hour, count: Number(r.count) }));

    const finances = {
      gross: round2(financeAgg._sum.totalAmount ?? 0),
      platformFee: round2(financeAgg._sum.platformFee ?? 0),
      net: round2(financeAgg._sum.organizerAmount ?? 0),
      paidOrders: financeAgg._count,
      soldTickets: financeAgg._sum.quantity ?? 0,
      feeRate: PLATFORM_FEE_RATE, // taux fixe prélevé sur chaque achat
    };

    return {
      event: { reference: event.reference, title: event.title },
      totals: { total, scanned, unused, cancelled, entryRate, capacity },
      byCategory,
      byAgent,
      timeline,
      finances,
    };
  }

  private async generateUniqueCode(): Promise<string>{
    for (let i = 0; i < 5; i++){
      const candidate = randomCode('AG',8); //AG-XXXXXXXX
      const existing = await this.prisma.agent.findUnique({ 
        where : {hashCode : hashCode(candidate)}})
    
    if (!existing) return candidate
    }
    throw new ForbiddenException('Impossible de générer un code unique après 5 essais.')
  }
}