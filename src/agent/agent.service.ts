import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { createHash} from 'crypto';
import * as bcrypt from 'bcrypt'
import { randomCode } from 'src/common/generate-code';
import { CreateAgentDto } from './dto/create-agent.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { EventsService } from 'src/events/events.service';

@Injectable()
export class AgentService {
  constructor(private readonly prisma: PrismaService) {}

  async CreatAgent(userId: string, reference : string, dto: CreateAgentDto){

    const event = await this.prisma.event.findUnique({ where: { id: reference } });
    // si aucune ligne ne correspont l'evenement n'existe pas 
    if (!event) {throw new NotFoundException('Evenement Introuvable')};

    // Seul le créateur de l'événement peut lui ajouter des agents.
    if (event.createdById !== userId) throw new ForbiddenException("Vous n'êtes pas invité à gerer cet événement.");

    const code = await this.generateUniqueCode(); // "AG-XXXXX" unique
    await this.prisma.agent.create({ data: {...dto, hashCode: this.computeHash(code), eventId: event.id}})

    const agent = await this.prisma.agent.create({
      data: {
        firstname : dto.firstname,
        lastname : dto.lastname,
        hashCode: this.computeHash(code),
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


  private async generateUniqueCode(): Promise<string>{
    for (let i = 0; i < 5; i++){
      const candidate = randomCode('AG',8); //AG-XXXXXXXX
      const existing = await this.prisma.agent.findUnique({ 
        where : {hashCode : this.computeHash(candidate)}})
    
    if (!existing) return candidate
    }
    throw new ForbiddenException('Impossible de générer un code unique après 5 essais.')
  }
  private computeHash(code: string): string{
    return createHash('sha256').update(code).digest('hex');// ⚠️
  }
}