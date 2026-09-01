import { BadRequestException, Controller, Get, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { MyTicketsService } from './MyTickets.service';
import { TicketAssetService } from 'src/ticket-asset/ticket-asset.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('USER')
@Controller('me')
export class MyTicketsController {
  constructor(
    private readonly myTicketsService: MyTicketsService,
    private readonly ticketAssets: TicketAssetService,
  ) {}

  // GET /me/tickets billets de l'utilisateur, groupés par événement.
  @Get('tickets')
  async myTickets(@Req() req) {
    return this.myTicketsService.getMyTickets(req.user.sub);
  }

  // GET /me/tickets/gifts — billets offerts encore visibles (UNUSED + non téléchargés).
  @Get('tickets/gifts')
  async myGifts(@Req() req) {
    return this.myTicketsService.getMyGifts(req.user.sub);
  }

  // GET /me/tickets/:id/qr-token — token du billet (propriétaire uniquement).
  @Get('tickets/:id/qr-token')
  async qrToken(@Req() req, @Param('id') id: string) {
    return this.myTicketsService.getQrToken(req.user.sub, id);
  }

  // GET /me/tickets/:id/download?format=png|pdf — fichier composé à la demande
  // (design + QR) et streamé directement dans la réponse : rien n'est stocké
  // côté Cloudinary, contrairement aux visuels générés post-commande. Ça évite
  // de payer un upload/stockage pour un fichier que l'utilisateur peut ne
  // jamais redemander, et garantit un rendu toujours à jour des données du billet.
  @Get('tickets/:id/download')
  async download(
    @Req() req,
    @Param('id') id: string,
    @Query('format') format: string,
    @Res() res: Response,
  ) {
    const wantsPdf = format === 'pdf';
    if (format && format !== 'pdf' && format !== 'png') {
      throw new BadRequestException("Format invalide (png|pdf).");
    }

    // ETag dérivé de l'id + format (pas du contenu, jamais stocké) : suffisant
    // ici car un billet ne change pas après émission ; court-circuite le
    // rendu (sharp/pdfkit) quand le navigateur a déjà la réponse en cache.
    const etag = `"${id}-${wantsPdf ? 'pdf' : 'png'}"`;
    if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }

    const t = await this.myTicketsService.getTicketForRender(req.user.sub, id);
    const input = {
      qrToken: t.qrToken,
      eventTitle: t.ticketCategory.event.title,
      eventCategory: t.ticketCategory.event.category,
      startDate: t.ticketCategory.event.startDate,
      categoryName: t.ticketCategory.name,
      designUrl: t.ticketCategory.ticketDesignUrl,
    };
    const buffer = wantsPdf
      ? await this.ticketAssets.renderTicketPdf(input)
      : await this.ticketAssets.renderTicketPng(input);

    const safe = `${t.ticketCategory.event.title}-${t.ticketCategory.name}`.replace(/[^\w.-]+/g, '_');
    res.setHeader('Content-Type', wantsPdf ? 'application/pdf' : 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="billet-${safe}.${wantsPdf ? 'pdf' : 'png'}"`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('ETag', etag);

    // Billet offert : premier téléchargement → disparition définitive de l'onglet offerts.
    if (t.order.paymentStatus === 'GIFT') {
      await this.myTicketsService.markGiftDownloaded(req.user.sub, id);
    }
    res.end(buffer);
  }
}
