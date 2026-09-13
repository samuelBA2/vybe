// Abstraction du fournisseur de paiement Mobile Money (indépendante du prestataire).
// Elle couvre les DEUX formes d'intégration possibles :
//   - A. Checkout hébergé (redirect) : initPayment renvoie une `paymentUrl`.
//   - B. Push Mobile Money (push + poll) : pas de `paymentUrl`, l'acheteur valide
//     par USSD/PIN sur son téléphone, puis callback + re-vérification serveur.
// L'implémentation concrète (PawaPayProvider) est branchée en Task 3b ; tout le
// flux (createOrder, webhook, reaper, comptabilité) consomme UNIQUEMENT cette
// interface, jamais l'implémentation → changer de fournisseur ne touche qu'une brique.

// Devise réellement débitée (miroir de l'enum Prisma `Currency`).
export type ProviderCurrency = 'USD' | 'CDF';

// Statut NORMALISÉ (indépendant du fournisseur). Chaque implémentation mappe ses
// propres statuts bruts vers ces valeurs.
export type ProviderStatus = 'ACCEPTED' | 'APPROVED' | 'DECLINED' | 'PENDING';

// Entrée d'initiation. Champs communs aux deux formes d'intégration. Les champs
// spécifiques au push (opérateur + numéro Mobile Money) seront ajoutés au choix
// du fournisseur (Task 3b). Aucune donnée sensible n'est persistée (minimisation).
export interface InitPaymentInput {
  // Notre référence de transaction, PARTAGÉE par les N commandes d'un checkout.
  paymentRef: string;
  // Montant total à débiter, exprimé dans `currency` (entier si CDF).
  amount: number;
  currency: ProviderCurrency;
  // URL de retour / callback (utile en checkout hébergé ; = API_BASE_URL + webhook).
  redirectUrl?: string;
  // Libellé présenté à l'acheteur, le cas échéant.
  description?: string;
}

export interface InitPaymentResult {
  // Référence de transaction (la nôtre, adaptée par le fournisseur).
  paymentRef: string;
  // Présent UNIQUEMENT en checkout hébergé (modèle A). Absent en push (modèle B).
  paymentUrl?: string;
}

export interface CheckStatusResult {
  status: ProviderStatus;
  // Montant confirmé par le fournisseur, si celui-ci l'expose (sert au contrôle
  // anti-divergence côté webhook → REVIEW si != Σ chargedAmount attendu).
  amount?: number;
  currency?: ProviderCurrency;
}

export interface PaymentProvider {
  // Initie le paiement. Renvoie une paymentUrl (checkout hébergé) ou un simple
  // accusé (push Mobile Money).
  initPayment(input: InitPaymentInput): Promise<InitPaymentResult>;

  // Re-vérifie le statut côté serveur par NOTRE référence = source de vérité.
  // JAMAIS se fier au seul callback.
  checkStatus(paymentRef: string): Promise<CheckStatusResult>;

  // Vérifie l'authenticité d'un webhook/callback (signature/HMAC propre au
  // fournisseur) sur le corps EXACT reçu. Renvoie false = rejeter (401).
  verifyWebhookSignature(
    rawBody: string,
    headers: Record<string, string>,
  ): boolean;
}

// Token d'injection Nest. L'implémentation concrète est liée à ce token en Task 3b :
//   { provide: PAYMENT_PROVIDER, useClass: PawaPayProvider }
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
