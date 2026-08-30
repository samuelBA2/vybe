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
    }[];
    byAgent: { agentId: string, name: string, scanned: number}[];
    timeline: { hour: string; count: number}[] // heur = ISO du début d'heure
    finances: {
        gross: number;        // Σ totalAmount (PAID)
        platformFee: number;  // Σ platformFee (PAID)
        net: number;          // Σ organizerAmount (PAID)
        paidOrders: number;   // nb commandes PAID
        soldTickets: number;  // Σ quantity (PAID)
    }
}   