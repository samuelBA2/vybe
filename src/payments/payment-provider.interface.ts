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
  // Champs spécifiques au PUSH Mobile Money (modèle B, ex. PawaPay). Optionnels au
  // niveau du contrat (un checkout hébergé les ignore) mais REQUIS par un provider
  // push, qui les valide à l'exécution.
  operator?: string; // code opérateur du fournisseur (ex. VODACOM_MPESA_COD)
  phoneNumber?: string; // numéro Mobile Money, chiffres uniquement, sans préfixe
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

// Contexte de la requête HTTP entrante, nécessaire pour vérifier une signature
// RFC-9421 qui couvre des composants DÉRIVÉS (@method / @path / @authority) — ce
// que PawaPay fait en PRODUCTION (le sandbox ne couvre que "content-digest"). Le
// corps + les headers ne suffisent pas à les résoudre : le contrôleur les fournit
// depuis la requête. Optionnel : un fournisseur qui ne signe que le corps l'ignore.
export interface WebhookRequestContext {
  method: string; // ex. 'POST'
  path: string; // chemin de la cible, sans query (ex. '/payments/webhook')
  authority: string; // autorité/hôte de l'URL appelée (ex. 'api.vybeplatform.app')
  query?: string; // query brute sans le '?' (ex. 'a=1&b=2'), le cas échéant
}

// Opérateur Mobile Money exposé au front (dérivé de la config fournisseur).
export interface ProviderOperator {
  code: string; // code fournisseur exact (ex. 'VODACOM_MPESA_COD')
  name: string; // nom affichable
  available: boolean; // true ssi `currencies` est non vide (invariant côté front)
  logoUrl?: string;
  // Devises pour lesquelles le DÉPÔT est utilisable MAINTENANT (status ≠ CLOSED).
  // Une devise CLOSED chez cet opérateur est exclue (ex. opérateur USD=OK,
  // CDF=CLOSED → currencies=['USD']), jamais proposée telle quelle par PawaPay.
  currencies: ProviderCurrency[];
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
  // `context` fournit méthode/chemin/authority pour les signatures RFC-9421 qui
  // couvrent des composants dérivés (@method/@path/@authority) — requis en prod
  // PawaPay ; sans lui, une telle signature est rejetée (fail-closed).
  verifyWebhookSignature(
    rawBody: string,
    headers: Record<string, string>,
    context?: WebhookRequestContext,
  ): boolean;

  // Liste les opérateurs Mobile Money disponibles pour le pays cible (dépôts).
  getOperators(): Promise<ProviderOperator[]>;
}

// Token d'injection Nest. L'implémentation concrète est liée à ce token en Task 3b :
//   { provide: PAYMENT_PROVIDER, useClass: PawaPayProvider }
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
