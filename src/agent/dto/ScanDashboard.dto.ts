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
    byCategory:{ name: string; sold: number; scanned: number; remaining: number}[];
    byAgent: { agentId: string, name: string, scanned: number}[];
    timeline: { hour: string; count: number}[] // heur = ISO du début d'heure
}   