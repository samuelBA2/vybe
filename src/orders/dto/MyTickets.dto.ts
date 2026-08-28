import { $Enums } from '@prisma/client';

// Un billet individuel tel que renvoyé au propriétaire (jamais le qrToken brut).
export interface MyTicketDto {
  id: string;
  categoryName: string;
  qrStatus: $Enums.QRStatus;
  ticketImageUrl: string | null; // PNG (design + QR) ; null si génération échouée
  pdfUrl: string | null;         // PDF ; null si génération échouée
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
    startDate: Date;
    endDate: Date;
    location: string;
    posterUrl: string | null; // EventMedia isPoster ; null si absent
  };
  tickets: MyTicketDto[];
}

// Réponse de GET /me/tickets : deux groupes, à venir et passés.
export interface MyTicketsResponseDto {
  upcoming: MyEventTicketsDto[];
  past: MyEventTicketsDto[];
}
