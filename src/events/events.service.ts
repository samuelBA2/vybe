import { BadRequestException, Injectable } from '@nestjs/common';
import { $Enums } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { MailService } from 'src/mail/mail.service';
import { EventModerationService } from './event-moderation.service';
import { CreateEventDto } from './dto/create-event.dto';

@Injectable()
export class EventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly moderationService: EventModerationService,
  ) {}

  async createEvent(userId: string, dto: CreateEventDto) {
    const start = new Date(dto.startDate);
    const end = new Date(dto.endDate);
    const deadline = new Date(dto.purchaseDeadline);
    const now = new Date();

    // ── Règles métier ───────────────────────────────────────────────
    if (start.getTime() <= now.getTime()) {
      throw new BadRequestException('La date de début doit être dans le futur.');
    }
    if (end.getTime() <= start.getTime()) {
      throw new BadRequestException(
        'La date de fin doit être postérieure à la date de début.',
      );
    }
    if (deadline.getTime() > start.getTime()) {
      throw new BadRequestException(
        "La date limite d'achat ne peut pas dépasser la date de début.",
      );
    }
    if (dto.termsAccepted !== true) {
      throw new BadRequestException('Vous devez accepter les conditions.');
    }

    const posters = dto.media.filter((m) => m.isPoster);
    if (posters.length !== 1) {
      throw new BadRequestException(
        'Vous devez fournir exactement une affiche (isPoster).',
      );
    }
    if (dto.ticketCategories.length < 1 || dto.ticketCategories.length > 4) {
      throw new BadRequestException(
        'Vous devez définir entre 1 et 4 catégories de billets.',
      );
    }

    // ── Création transactionnelle (Event + médias + catégories) ──────
    const event = await this.prisma.event.create({
      data: {
        title: dto.title,
        description: dto.description,
        startDate: start,
        endDate: end,
        location: dto.location,
        gpsLat: dto.gpsLat ?? null,
        gpsLng: dto.gpsLng ?? null,
        purchaseDeadline: deadline,
        dressCode: dto.dressCode ?? null,
        category: dto.category,
        termsAccepted: true,
        status: $Enums.EventStatus.PENDING_REVIEW,
        createdById: userId,
        mediaFiles: {
          create: dto.media.map((m) => ({
            url: m.url,
            fileKey: m.fileKey,
            fileName: m.fileName,
            mimeType: m.mimeType,
            sizeBytes: m.sizeBytes,
            mediaType: m.mediaType,
            isPoster: m.isPoster,
          })),
        },
        ticketCategories: {
          create: dto.ticketCategories.map((t) => ({
            name: t.name,
            price: t.price,
            ticketDesignUrl: t.ticketDesignUrl,
            totalStock: null, // stock illimité
            maxPerOrder: t.maxPerOrder ?? 10,
            benefits: t.benefits ?? null,
          })),
        },
      },
      include: { createdBy: true },
    });

    // ── Déclencher la modération (mail équipe avec liens magiques) ───
    const token = this.moderationService.generateModerationToken(event.id);
    const base = process.env.API_BASE_URL ?? '';
    const approveUrl = `${base}/events/moderate?token=${token}&decision=approve`;
    const rejectUrl = `${base}/events/moderate?token=${token}&decision=reject`;
    const teamEmail =
      process.env.VYBE_TEAM_EMAIL ?? process.env.SENDGRID_FROM_EMAIL!;
    const poster = posters[0];

    await this.mailService.sendEventModerationEmail({
      to: teamEmail, // à verifier, le mail de l'équipe vybe
      title: dto.title,
      description: dto.description,
      startDate: start,
      endDate: end,
      location: dto.location,
      gpsLat: dto.gpsLat ?? null,
      gpsLng: dto.gpsLng ?? null,
      category: dto.category,
      dressCode: dto.dressCode ?? null,
      purchaseDeadline: deadline,
      creatorLabel: event.createdBy?.email ?? userId,
      posterUrl: poster.url,
      ticketCategories: dto.ticketCategories.map((t) => ({
        name: t.name,
        price: t.price,
        ticketDesignUrl: t.ticketDesignUrl,
      })),
      approveUrl,
      rejectUrl,
    });

    return {
      message:
        "Votre événement a été soumis à validation. L'équipe Vybe vous informera de sa décision.",
      eventId: event.id,
      status: event.status,
    };
  }
}
