import { $Enums } from '@prisma/client';

// Un billet individuel tel que renvoyé au propriétaire (jamais le qrToken brut).
export interface MyTicketDto {
  id: string;
  categoryName: string;
  qrStatus: $Enums.QRStatus;
  ticketDesignUrl: string;       // design de la catégorie (fond du billet, rendu client-side)
  expiresAt: Date;
  cancelledAt: Date | null;
}

// Un événement + les billets que l'utilisateur y possède.
export interface MyEventTicketsDto {
  event: {
    id: string;
    reference: string;
    title: string;
    category: $Enums.EventCategory; // ex. CONCERT — affiché en tête du billet
    startDate: Date;
    endDate: Date;
    location: string;
    posterUrl: string | null; // EventMedia isPoster ; null si absent
  };
  tickets: MyTicketDto[];
}

// Réponse de GET /me/tickets : deux groupes, à venir et passés.
// `truncated` : true si un scope a atteint le plafond de sécurité MY_TICKETS_MAX_PER_SCOPE
// (jamais pour un utilisateur réel) — signale une troncature au lieu de la masquer.
export interface MyTicketsResponseDto {
  upcoming: MyEventTicketsDto[];
  past: MyEventTicketsDto[];
  truncated: boolean;
}

// Réponse de GET /me/tickets/gifts : billets offerts encore visibles, groupés par événement.
export interface MyGiftsResponseDto {
  events: MyEventTicketsDto[];
}
