import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { $Enums } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { MailService } from 'src/mail/mail.service';
import { EventModerationService } from './event-moderation.service';
import { CreateEventDto } from './dto/create-event.dto';
import { randomCode } from 'src/common/generate-code';

// Limite globale de l'application : nombre maximum de billets pour un événement en mode limité.
const MAX_TOTAL_CAPACITY = 50000;

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly moderationService: EventModerationService,
  ) {}

  // Liste publique : uniquement les événements validés par la modération,
  // triés par date de début, avec médias et catégories de billets.
  async findPublished() {
    return this.prisma.event.findMany({
      where: { status: $Enums.EventStatus.PUBLISHED,
        endDate: { gte: new Date() } //garde les événements qui ne sont pas encore terminés
      },
      orderBy: { startDate: 'asc' },
      include: { mediaFiles: true, ticketCategories: true },
    });
  }

  // Met à jour l'affiche (EventMedia isPoster) après upload Cloudinary :
  // on remplace url + fileKey de la ligne poster existante de l'événement.
  async updatePoster(eventId: string, media: { url: string; publicId: string }) {
    return this.prisma.eventMedia.updateMany({
      where: { eventId, isPoster: true },
      data: { url: media.url, publicId: media.publicId },
    });
  }

  // Événements de l'organisateur connecté, tous statuts confondus
  // (il doit voir ses événements en attente de modération).
  async findMine(userId: string) {
    return this.prisma.event.findMany({
      where: { createdById: userId },
      orderBy: { createdAt: 'desc' },
      include: { mediaFiles: true, ticketCategories: true },
    });
  }

  async findOne(eventId: string) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      include: { mediaFiles: true, ticketCategories: true, createdBy: { select: { id: true, email: true, firstname: true, lastname: true } } },
    });
    if (!event) {
      throw new NotFoundException('Événement introuvable.');
    }
    return event;
  }

  private async generateUniqueReference(): Promise<string>{
    for (let i = 0; i < 5; i++){
      const candidate = randomCode('VYBE', 6);
      const existing = await this.prisma.event.findUnique({
        where: {  reference: candidate},
      });
      if (!existing) return candidate;
    }
    throw new Error('Impossible de générer une référence unique après 5 essais.')
  }

  async createEvent(userId: string, dto: CreateEventDto) {
    const start = new Date(dto.startDate);
    const end = new Date(dto.endDate);
    const deadline = new Date(dto.purchaseDeadline);
    const now = new Date(); 

    // ── Règles métier ───────────────────────────────────────────────
    if (start.getTime() <= now.getTime()) {
      throw new BadRequestException('La date de début de votre evenement doit être dans le futur.');
    }
    if (end.getTime() <= start.getTime()) {
      throw new BadRequestException('La date de fin doit être postérieure à la date de début.',);
    }
    if (deadline.getTime() > end.getTime()) {
      throw new BadRequestException("La date limite d'achat ne peut pas dépasser la date de fin de l'événement.",);
    }
    if (dto.termsAccepted !== true) {
      throw new BadRequestException('Vous devez accepter les conditions.');
    }

    const posters = dto.media.filter((m) => m.isPoster);
    if (posters.length > 1) {
      throw new BadRequestException("Un événement ne peut avoir qu'une seule affiche.",);
    }
    if (dto.ticketCategories.length < 1 || dto.ticketCategories.length > 4) {
      throw new BadRequestException('Vous devez définir entre 1 et 4 catégories de billets.',);
    }

    // ── Stock : billetterie illimitée (case cochée) ou limitée (par défaut) ──
    // eventCapacity = capacité totale de l'événement : null en illimité, sinon le nombre choisi.
    let eventCapacity: number | null = null;
    // Seul unlimitedStock === true = illimité. Absent ou false = limité → on valide la jauge.
    if (dto.unlimitedStock !== true) {
      // 1) En mode limité, la capacité totale est obligatoire.
      if (dto.totalCapacity == null) {
        throw new BadRequestException(
          'En stock limité, vous devez indiquer le nombre total de billets.',
        );
      }
      // 2) La capacité doit rester dans les bornes de l'application (1 à 50 000).
      if (dto.totalCapacity < 1 || dto.totalCapacity > MAX_TOTAL_CAPACITY) {
        throw new BadRequestException(
          `Le nombre total de billets doit être compris entre 1 et ${MAX_TOTAL_CAPACITY}.`,
        );
      }
      // 3) Chaque catégorie doit déclarer son allocation, et on cumule pour comparer à la jauge.
      let sum = 0;
      for (const t of dto.ticketCategories) {
        if (t.totalStock == null) {
          throw new BadRequestException(
            `En stock limité, la catégorie « ${t.name} » doit indiquer son nombre de billets.`,
          );
        }
        sum += t.totalStock;
      }
      // 4) La somme des catégories ne peut pas dépasser la capacité totale annoncée.
      if (sum > dto.totalCapacity) {
        throw new BadRequestException(
          'Vous avez dépassé le nombre des billets que vous avez commandé, si vous voulez un nombre plus élevé veuillez souscrire pour les billets en illimité.',
        );
      }
      // Tout est valide : on retient la capacité à persister sur l'événement.
      eventCapacity = dto.totalCapacity;
    }
     // ── Référence publique unique (ex. "VYBE-XXXXX")
    const reference = await this.generateUniqueReference();

    // ── Création transactionnelle (Event + médias + catégories) ──────
    const event = await this.prisma.event.create({
      data: {
        title: dto.title,  
        reference,
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
        totalCapacity: eventCapacity, // null = billetterie illimitée ; sinon la jauge choisie
        createdById: userId,
        mediaFiles: {
          create: dto.media.map((m) => ({
            url: m.url,
            publicId: m.fileKey, // fileKey renvoyé par /uploads = public_id Cloudinary
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
            // Illimité → null ; limité → l'allocation de la catégorie (déjà validée ci-dessus)
            totalStock: dto.unlimitedStock === true ? null : (t.totalStock ?? null),
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
    const teamEmail = process.env.VYBE_TEAM_EMAIL ?? process.env.SENDGRID_FROM_EMAIL!;
    const poster = posters[0];

    // Les médias soumis ne sont plus orphelins → on les protège de la purge.
    // updateMany filtré par ownerId : un utilisateur ne peut pas "revendiquer"
    // le fichier d'un autre. Non bloquant si un fileKey est inconnu (0 update).
    const filesKeys = dto.media.map((m) => m.fileKey);
    if (filesKeys.length) {
      await this.prisma.uploadedAsset.updateMany({
        where: { publicId: { in: filesKeys}, ownerId: userId},
        data: { attached: true },
      })
    }

    // L'événement est déjà persisté (source de vérité). L'envoi d'email est une
    // action externe non transactionnelle : un échec SendGrid ne doit PAS faire
    // échouer la requête ni laisser croire au client que la création a raté.
    // On retente automatiquement (pannes passagères) puis on logge en dernier
    // recours pour permettre une re-notification manuelle.
    try {
      await this.sendWithRetry(() =>
        this.mailService.sendEventModerationEmail({
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
          posterUrl: poster?.url ?? null,
          totalCapacity: eventCapacity,
          ticketCategories: dto.ticketCategories.map((t) => ({
            name: t.name,
            price: t.price,
            ticketDesignUrl: t.ticketDesignUrl,
            totalStock:
              dto.unlimitedStock === true ? null : (t.totalStock ?? null),
          })),
          approveUrl,
          rejectUrl,
        }),
      );
    } catch (err) {
      this.logger.error(
        `Échec de l'envoi de l'email de modération pour l'événement ${event.id} après plusieurs tentatives`,
        err instanceof Error ? err.stack : String(err),
      );
    }

    return {
      message:
        "Votre événement a été soumis à validation. L'équipe Vybe vous informera de sa décision.",
      eventId: event.id,
      status: event.status,
      reference: event.reference,
    };
  }

  // Retente une action asynchrone (ici l'envoi d'email) en cas d'échec passager.
  // Délai croissant entre les tentatives (1s, 2s…). Invisible pour le client :
  // tout se déroule côté serveur pendant le traitement de la requête.
  // Relance l'erreur après la dernière tentative (l'appelant décide quoi en faire).
  private async sendWithRetry(
    action: () => Promise<unknown>,
    attempts = 3,
  ): Promise<void> {
    for (let i = 1; i <= attempts; i++) {
      try {
        await action();
        return;
      } catch (err) {
        if (i === attempts) throw err;
        this.logger.warn(
          `Tentative ${i}/${attempts} d'envoi d'email échouée, nouvelle tentative…`,
        );
        await new Promise((resolve) => setTimeout(resolve, i * 1000));
      }
    }
  }
}
