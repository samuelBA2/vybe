import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcrypt'
import { randomCode } from 'src/common/generate-code';
import { CreateAgentDto } from './dto/create-agent.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { hashCode } from 'src/common/hash-code';

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