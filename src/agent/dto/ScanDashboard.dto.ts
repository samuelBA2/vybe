export interface ScanDashboardResponseDto {
    event: {reference: string, title: string };
    totals:{
        total: number;
        scanned: number;
        unused: number; // Billets UNUSED (non scannés)
        cancelled: number; // Billets CANCELLED
        entryRate: number; // scanned / (scanned + unused), fraction 0..1 à 4 décimales, 0 si nul
        capacity: number | null; // Capacité totale de l'event (somme des totalStock) ; null = billetterie illimitée (au moins 1 catégorie sans plafond)
    };
    byCategory:{ 
        name: string; 
        sold: number; 
        scanned: number; 
        remaining: number  | null  // INVENTAIRE : totalStock-soldCount, null = illimité
        awaitingCheckIn: number;  // vendus pas encore scannés : soldCount-scanned
        revenue: number;  // brut PAID de la catégorie (Σ totalAmount)
        gifted: number;   // billets OFFERTS de la catégorie (giftedCount), inclus dans sold
    }[];
    byAgent: { agentId: string, name: string, scanned: number}[];
    // hour = début d'heure en HEURE LOCALE de l'événement (APP_TIMEZONE), format
    // 'YYYY-MM-DDTHH:00:00' SANS suffixe Z. Le front l'affiche tel quel (pas de
    // reconversion de fuseau) pour ne pas décaler les heures vues par l'organisateur.
    timeline: { hour: string; count: number}[]
    finances: {
        gross: number;        // Σ totalAmount (PAID)
        platformFee: number;  // Σ platformFee (PAID) — somme des commissions prélevées à chaque achat
        net: number;          // Σ organizerAmount (PAID)
        paidOrders: number;   // nb commandes PAID
        soldTickets: number;  // Σ quantity (PAID)
        feeRate: number;      // taux de commission fixe prélevé sur chaque achat (PLATFORM_FEE_RATE, ex. 0.20)
    }
    // Espace « offerts gratuitement » : comptage des billets offerts, séparé du
    // calcul financier (les GIFT ne sont jamais des ventes PAID).
    gifts: {
        total: number;
        byCategory: { name: string; count: number }[];
    };
}