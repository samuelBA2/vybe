import { Controller, Get, Post, Body, Patch, Param, Req, UseGuards, Delete } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator'
import { AgentService } from './agent.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { ScanDto } from './dto/ScanDto';

@Controller()//pas de préfixe : chemains complets sur chaque route
export class AgentController {
  constructor(private readonly agentService: AgentService) {}

   // Créer un agent pour un événement (organisateur uniquement).
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('USER')
  @Post('events/:reference/agents')
  async create(
    @Req() req, 
    @Param('reference') reference: string,
    @Body() dto: CreateAgentDto,
  ) {
    return this.agentService.CreatAgent(req.user.sub, reference, dto);
  }

   // Lister les agents d'un événement (propriété vérifiée dans le service).
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('USER')
  @Get('events/:reference/agents')
  async list(@Req() req, @Param('reference') reference: string) {
    return this.agentService.listAgents(req.user.sub, reference);
  }

   // Révoquer un agent (active = false).
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('USER')
  @Patch('agents/:id/deactivate')
  async deactivate(@Req() req, @Param('id') id: string) {
    return this.agentService.deleteAgent(req.user.sub, id);
  }

   //Scanne qrcode 
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('AGENT')
  @Post('agents/scan')
  async scan(@Req() req, @Body() dto: ScanDto){
    return this.agentService.scan(req.user.eventId, req.user.agentId, dto.qrToken)
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('USER')
  @Get('events/:reference/scan-dashboard')
  async getScanDashboard(@Req() req, @Param('reference') reference: string) {
    return this.agentService.getScanDashboard(req.user.sub, reference);
  }
}
