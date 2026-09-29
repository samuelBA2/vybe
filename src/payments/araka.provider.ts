import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import {
  CheckStatusResult,
  InitPaymentInput,
  InitPaymentResult,
  InitPayoutInput,
  InitPayoutResult,
  PaymentProvider,
  ProviderDeclinedError,
  ProviderOperator,
} from './payment-provider.interface';

const HTTP_TIMEOUT_MS = 15_000;
// On renouvelle le token un peu AVANT son expiration réelle.
const TOKEN_SAFETY_MARGIN_MS = 60_000;
// Token sans `exp` lisible : durée de vie prudente (le token ARAKA dure 2 h).
const TOKEN_FALLBACK_TTL_MS = 110 * 60_000;

// Opérateurs ARAKA (codes de `paymentChannel.provider` / `destination.provider`).
// Préfixes = après l'indicatif 243 : usuels RDC, cohérents avec les numéros de test
// ARAKA — à confirmer par ProxyPay. AFRIMONEY n'est pas proposé en décaissement.
export const ARAKA_OPERATORS = [
  {
    code: 'MPESA',
    name: 'M-Pesa',
    phonePrefixes: ['81', '82', '83'],
    payout: true,
  },
  {
    code: 'ORANGE',
    name: 'Orange Money',
    phonePrefixes: ['80', '84', '85', '89'],
    payout: true,
  },
  {
    code: 'AIRTEL',
    name: 'Airtel Money',
    phonePrefixes: ['97', '98', '99'],
    payout: true,
  },
  {
    code: 'AFRIMONEY',
    name: 'Afrimoney',
    phonePrefixes: ['90', '91'],
    payout: false,
  },
] as const;

// Réponse (partielle) de paymentrequest / sendmobilemoney.
interface ArakaInitResponse {
  transactionId?: string;
  originatingTransactionId?: string;
  statusCode?: string;
  statusDescription?: string;
}

// Élément (partiel) de la réponse de transactionstatusbyreference. Le sandbox
// renvoie un TABLEAU d'éléments `status` ; le manuel documente un objet unique
// `statusDescription` : on accepte les deux formes.
interface ArakaStatusItem {
  transactionId?: string;
  status?: string;
  statusDescription?: string;
  transactionReference?: string;
  originatingTransactionId?: string;
}

interface ArakaHttpResult {
  status: number;
  body: unknown;
}

// Implémentation du PaymentProvider pour ARAKA (ProxyPay) — agrégateur Mobile Money
// RDC (M-Pesa, Orange, Airtel, Afrimoney). Modèle PUSH : on pousse la demande,
// l'acheteur valide par USSD/PIN, puis callback (HMAC) + re-vérification serveur
// par référence (source de vérité). Auth : POST /login → JWT Bearer de 2 h.
@Injectable()
export class ArakaProvider implements PaymentProvider {
  private readonly logger = new Logger(ArakaProvider.name);
  private readonly baseUrl: string;
  private readonly email: string;
  private readonly password: string;
  private readonly paymentPageId: string;
  private readonly callbackKey: string;
  private readonly disabledOperators: Set<string>;
  private token?: string;
  private tokenExpiresAt = 0;

  constructor(private readonly config: ConfigService) {
    // Sans slash final : on concatène des chemins '/pay/...'.
    this.baseUrl = (this.config.get<string>('ARAKA_BASE_URL') ?? '').replace(
      /\/+$/,
      '',
    );
    // V6 : identifiants marchands et token ne circulent JAMAIS en clair.
    if (this.baseUrl && !this.baseUrl.startsWith('https://')) {
      throw new Error(
        'ARAKA_BASE_URL doit commencer par https:// (identifiants marchands).',
      );
    }
    this.email = this.config.get<string>('ARAKA_EMAIL') ?? '';
    this.password = this.config.get<string>('ARAKA_PASSWORD') ?? '';
    this.paymentPageId = this.config.get<string>('ARAKA_PAYMENT_PAGE_ID') ?? '';
    this.callbackKey = this.config.get<string>('ARAKA_CALLBACK_KEY') ?? '';
    // V7 : interrupteur manuel (ex. "ORANGE,AIRTEL") pour griser un opérateur en panne.
    this.disabledOperators = new Set(
      (this.config.get<string>('ARAKA_DISABLED_OPERATORS') ?? '')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    );

    const missing = [
      'ARAKA_BASE_URL',
      'ARAKA_EMAIL',
      'ARAKA_PASSWORD',
      'ARAKA_PAYMENT_PAGE_ID',
    ].filter((k) => !this.config.get<string>(k));
    if (missing.length > 0) {
      // Pas de crash : les appels échoueront proprement (exception → compensation).
      this.logger.error(
        `Configuration ARAKA incomplète : ${missing.join(', ')} manquante(s).`,
      );
    }
  }

  async initPayment(input: InitPaymentInput): Promise<InitPaymentResult> {
    if (!input.operator || !input.phoneNumber) {
      // Rien n'est envoyé : refus explicite (le service compense proprement).
      throw new ProviderDeclinedError(
        'ARAKA : opérateur et numéro Mobile Money requis.',
      );
    }
    const res = await this.request(
      'POST',
      '/pay/paymentrequest',
      {
        order: {
          paymentPageId: this.paymentPageId,
          transactionReference: input.paymentRef,
          amount: input.amount,
          currency: input.currency,
          redirectURL: input.redirectUrl,
        },
        paymentChannel: {
          channel: 'MOBILEMONEY',
          provider: input.operator,
          walletID: `+${input.phoneNumber}`,
        },
      },
      // Callback signé HMAC (header X-APP-SIGNATURE), cf. manuel ARAKA 2.2.2.
      { 'X-API-CALLBACK-MODE': '2' },
    );
    const body = (res.body ?? {}) as ArakaInitResponse;
    if (this.isExplicitRefusal(res.status, body)) {
      throw new ProviderDeclinedError(
        `ARAKA a refusé le paiement (HTTP ${res.status}) : ${body.statusDescription ?? 'sans détail'}.`,
      );
    }
    if (
      this.isSuccessHttp(res.status) &&
      (body.statusCode === '202' || body.statusDescription === 'ACCEPTED')
    ) {
      return {
        paymentRef: input.paymentRef,
        providerTxnId: body.transactionId,
      };
    }
    // Issue inconnue : la transaction a PU être créée → exception ordinaire.
    throw new Error(
      `ARAKA : réponse inattendue à paymentrequest (HTTP ${res.status}, statusCode ${body.statusCode ?? '?'}).`,
    );
  }

  checkStatus(paymentRef: string): Promise<CheckStatusResult> {
    return this.statusByReference(paymentRef);
  }

  checkPayoutStatus(payoutRef: string): Promise<CheckStatusResult> {
    return this.statusByReference(payoutRef);
  }

  // HMAC-SHA256 (clé UTF-8) du corps BRUT, comparé en temps constant à
  // X-APP-SIGNATURE décodé en base64 (exemple C# `VerifyCallback` du manuel).
  verifyWebhookSignature(
    rawBody: string,
    headers: Record<string, string>,
  ): boolean {
    if (!this.callbackKey) return false; // fail-closed tant que la clé n'est pas fournie
    const header = headers['x-app-signature'];
    if (!header) return false;
    const expected = createHmac('sha256', Buffer.from(this.callbackKey, 'utf8'))
      .update(rawBody, 'utf8')
      .digest();
    const received = Buffer.from(header, 'base64');
    return (
      received.length === expected.length && timingSafeEqual(received, expected)
    );
  }

  extractPaymentRef(rawBody: string): string | undefined {
    return this.extractRef(rawBody);
  }

  extractPayoutRef(rawBody: string): string | undefined {
    return this.extractRef(rawBody);
  }

  // Pas d'endpoint d'état des opérateurs chez ARAKA : liste fixe + interrupteur V7.
  getOperators(): Promise<ProviderOperator[]> {
    return Promise.resolve(
      ARAKA_OPERATORS.map((op): ProviderOperator => {
        const disabled = this.disabledOperators.has(op.code);
        return {
          code: op.code,
          name: op.name,
          available: !disabled,
          currencies: disabled ? [] : ['USD', 'CDF'],
          payoutAvailable: !disabled && op.payout,
          phonePrefixes: [...op.phonePrefixes],
        };
      }),
    );
  }

  async initPayout(input: InitPayoutInput): Promise<InitPayoutResult> {
    const op = ARAKA_OPERATORS.find((o) => o.code === input.operator);
    if (!op || !op.payout || this.disabledOperators.has(input.operator)) {
      // Défense en profondeur (PayoutsService refuse déjà avant le débit) : rien n'est envoyé.
      return { payoutRef: input.payoutRef, status: 'DECLINED' };
    }
    const res = await this.request('POST', '/pay/sendmobilemoney', {
      order: {
        transactionReference: input.payoutRef,
        amount: input.amount,
        currency: input.currency,
      },
      destination: {
        provider: input.operator,
        walletID: `+${input.phoneNumber}`,
      },
    });
    const body = (res.body ?? {}) as ArakaInitResponse;
    if (this.isExplicitRefusal(res.status, body)) {
      return {
        payoutRef: input.payoutRef,
        providerPayoutId: body.transactionId,
        status: 'DECLINED',
      };
    }
    const desc = (body.statusDescription ?? '').toUpperCase();
    if (
      this.isSuccessHttp(res.status) &&
      (body.statusCode === '200' ||
        body.statusCode === '202' ||
        desc === 'SUCCESS' ||
        desc === 'ACCEPTED')
    ) {
      // 200 SUCCESS ne PROUVE PAS le crédit du destinataire : ACCEPTED, le reaper
      // confirme via checkPayoutStatus (source de vérité).
      return {
        payoutRef: input.payoutRef,
        providerPayoutId: body.transactionId,
        status: 'ACCEPTED',
      };
    }
    throw new Error(
      `ARAKA : réponse inattendue à sendmobilemoney (HTTP ${res.status}).`,
    );
  }

  // ── Interne ────────────────────────────────────────────────────────────────

  // Agrège la réponse de transactionstatusbyreference (ARAKA ne déduplique pas les
  // références : plusieurs transactions possibles sous une même référence).
  private async statusByReference(ref: string): Promise<CheckStatusResult> {
    const res = await this.request(
      'GET',
      `/reporting/transactionstatusbyreference/${encodeURIComponent(ref)}`,
    );
    // Référence jamais vue par ARAKA (vérifié en sandbox) : en cours → le reaper
    // l'expirera au TTL.
    if (res.status === 404) return { status: 'PENDING' };
    if (!this.isSuccessHttp(res.status)) {
      // 500 & co : statut INCONNU, jamais un refus (une panne ne doit pas faire
      // échouer un paiement réussi).
      throw new Error(
        `ARAKA : statut indisponible pour ${ref} (HTTP ${res.status}).`,
      );
    }
    const raw = res.body;
    const items: ArakaStatusItem[] = Array.isArray(raw)
      ? (raw as ArakaStatusItem[])
      : raw && typeof raw === 'object'
        ? [raw]
        : [];
    // V5 : seules les transactions portant EXACTEMENT notre référence comptent.
    const mine = items.filter(
      (it) => (it.originatingTransactionId ?? it.transactionReference) === ref,
    );
    if (mine.length !== items.length) {
      this.logger.warn(
        `ARAKA : ${items.length - mine.length} transaction(s) ignorée(s) (référence ≠ ${ref}).`,
      );
    }
    const statuses = mine.map((it) =>
      (it.status ?? it.statusDescription ?? '').toUpperCase(),
    );
    const approvedCount = statuses.filter((s) => s === 'APPROVED').length;
    // Un débit confirmé est toujours honoré ; un refus n'est retenu que s'il est
    // explicite et unanime ; tout le reste (ACCEPTED, PENDING, inconnu) = en cours.
    if (approvedCount > 0) return { status: 'APPROVED', approvedCount };
    if (statuses.length > 0 && statuses.every((s) => s === 'DECLINED')) {
      return { status: 'DECLINED' };
    }
    return { status: 'PENDING' };
  }

  // Appel authentifié. Sur 401 : un seul re-login + nouvel essai (token révoqué ou
  // expiré plus tôt que prévu), puis exception.
  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<ArakaHttpResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.getToken();
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (res.status === 401) {
        this.token = undefined; // force le re-login
        continue;
      }
      return { status: res.status, body: await this.readBody(res) };
    }
    throw new Error('ARAKA : authentification refusée après re-login.');
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const res = await fetch(`${this.baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        emailAddress: this.email,
        password: this.password,
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ARAKA : login refusé (HTTP ${res.status}).`);
    const body = (await this.readBody(res)) as { token?: string } | undefined;
    if (!body?.token) throw new Error('ARAKA : login sans token.');
    this.token = body.token;
    this.tokenExpiresAt = this.tokenExpiry(body.token);
    return body.token;
  }

  // Expiration lue dans le claim `exp` du JWT (sans vérifier sa signature : on ne
  // s'en sert que pour savoir QUAND se reconnecter), moins une marge de sécurité.
  private tokenExpiry(token: string): number {
    try {
      const payload = JSON.parse(
        Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
      ) as { exp?: unknown };
      if (typeof payload.exp === 'number')
        return payload.exp * 1000 - TOKEN_SAFETY_MARGIN_MS;
    } catch {
      // token opaque : durée par défaut ci-dessous
    }
    return Date.now() + TOKEN_FALLBACK_TTL_MS;
  }

  private async readBody(res: Response): Promise<unknown> {
    const text = await res.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  private extractRef(rawBody: string): string | undefined {
    try {
      const body = JSON.parse(rawBody) as {
        originatingTransactionId?: unknown;
      };
      return typeof body.originatingTransactionId === 'string' &&
        body.originatingTransactionId
        ? body.originatingTransactionId
        : undefined;
    } catch {
      return undefined;
    }
  }

  private isSuccessHttp(status: number): boolean {
    return status >= 200 && status < 300;
  }

  // Refus EXPLICITE : HTTP 400/403, ou HTTP 2xx dont le corps dit 400/403/DECLINED.
  private isExplicitRefusal(status: number, body: ArakaInitResponse): boolean {
    if (status === 400 || status === 403) return true;
    return (
      this.isSuccessHttp(status) &&
      (body.statusCode === '400' ||
        body.statusCode === '403' ||
        (body.statusDescription ?? '').toUpperCase() === 'DECLINED')
    );
  }
}
