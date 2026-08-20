import { ConflictException, Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcrypt'
import { randomCode } from 'src/common/generate-code';
import { CreateAgentDto } from './dto/create-agent.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { hashCode } from 'src/common/hash-code';
import { MAX_AGENTS_PER_EVENT } from 'src/common/constants';
import { ScanDashboardResponseDto } from './dto/ScanDashboard.dto';

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
    if (ticket.qrStatus === 'USED') throw new ConflictException (`Billet déjà scanné le ${ticket.scannedAt?.toISOString()}.`)

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
      select: { id: true, name: true, soldCount: true, totalStock: true },
    });
    const usedByCategory = await this.prisma.ticket.groupBy({
      by: ['ticketCategoryId'],
      where: { qrStatus: 'USED', ...eventFilter },
      _count: true,
    });
    const scannedForCat = (id: string): number =>
      usedByCategory.find((g: any) => g.ticketCategoryId === id)?._count ?? 0;
    const byCategory = categories.map((c) => {
      const catScanned = scannedForCat(c.id);
      return { name: c.name, sold: c.soldCount, scanned: catScanned, remaining: c.soldCount - catScanned };
    });

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

    // 4. Timeline (buckets horaires, troncature en UTC pour un résultat déterministe)
    const usedTickets = await this.prisma.ticket.findMany({
      where: { qrStatus: 'USED', ...eventFilter },
      select: { scannedAt: true },
    });
    const buckets = new Map<string, number>();
    for (const t of usedTickets) {
      if (!t.scannedAt) continue;
      const d = new Date(t.scannedAt);
      d.setUTCMinutes(0, 0, 0);
      const key = d.toISOString();
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    const timeline = [...buckets.entries()]
      .map(([hour, count]) => ({ hour, count }))
      .sort((a, b) => a.hour.localeCompare(b.hour));

    return {
      event: { reference: event.reference, title: event.title },
      totals: { total, scanned, unused, cancelled, entryRate },
      byCategory,
      byAgent,
      timeline,
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