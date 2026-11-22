import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  CheckStatusResult,
  InitPaymentInput,
  InitPaymentResult,
  PaymentProvider,
  ProviderCurrency,
  ProviderOperator,
  ProviderStatus,
} from './payment-provider.interface';
import { ARAKA_HTTP_TIMEOUT_MS } from 'src/common/constants';

// Réponse de POST /v1/auth/token (forme classique, NON enveloppée).
interface TokenResponse {
  accessToken?: string;
  tokenType?: string;
  expiresIn?: number;
}

// Enveloppe standard des endpoints métier v1.
interface Envelope<T> {
  responseCode?: string;
  responseDescription?: string;
  data?: T;
}

interface StatusData {
  externalReference?: string;
  systemReference?: string;
  status?: string;
  statusName?: string;
  amount?: number | string;
  currency?: string;
}

// Préfixes réseau RDC (après l'indicatif 243) → opérateur Vybe. Araka déduit
// lui-même le fournisseur du préfixe du walletId ; on le recalcule ici pour
// refuser AVANT l'appel un numéro qui ne correspond pas à l'opérateur choisi
// (sinon l'acheteur recevrait la demande de PIN sur un autre réseau, ou rien).
const PREFIX_TO_OPERATOR: Record<string, string> = {
  '97': 'AIRTEL',
  '98': 'AIRTEL',
  '99': 'AIRTEL',
  '96': 'AIRTEL',
  '25': 'AIRTEL',
  '81': 'MPESA',
  '82': 'MPESA',
  '83': 'MPESA',
  '84': 'ORANGE',
  '85': 'ORANGE',
  '89': 'ORANGE',
  '90': 'AFRIMONEY',
  '91': 'AFRIMONEY',
};

// Codes opérateur acceptés en entrée (codes Vybe + alias PawaPay historiques).
const OPERATOR_ALIASES: Record<string, string> = {
  MPESA: 'MPESA',
  VODACOM: 'MPESA',
  VODACOM_MPESA_COD: 'MPESA',
  AIRTEL: 'AIRTEL',
  AIRTEL_COD: 'AIRTEL',
  AIRTEL_OAPI_COD: 'AIRTEL',
  ORANGE: 'ORANGE',
  ORANGE_COD: 'ORANGE',
  ORANGE_MONEY_COD: 'ORANGE',
  AFRIMONEY: 'AFRIMONEY',
  AFRICELL: 'AFRIMONEY',
  AFRICELL_COD: 'AFRIMONEY',
};

const OPERATORS: ProviderOperator[] = [
  {
    code: 'MPESA',
    name: 'Vodacom M-Pesa',
    available: true,
    currencies: ['USD', 'CDF'],
  },
  {
    code: 'AIRTEL',
    name: 'Airtel Money',
    available: true,
    currencies: ['USD', 'CDF'],
  },
  {
    code: 'ORANGE',
    name: 'Orange Money',
    available: true,
    currencies: ['USD', 'CDF'],
  },
  {
    code: 'AFRIMONEY',
    name: 'Afrimoney',
    available: true,
    currencies: ['USD', 'CDF'],
  },
];

// Fenêtre d'acceptation d'un callback (doc v1 : rejeter au-delà de 5 min).
const WEBHOOK_MAX_AGE_SEC = 5 * 60;
// Tolérance d'horloge pour un horodatage légèrement dans le futur.
const WEBHOOK_MAX_SKEW_SEC = 60;
// Jeton de secours si `expiresIn` est absent (la doc annonce 3600 s).
const TOKEN_FALLBACK_TTL_MS = 55 * 60_000;

// Implémentation PaymentProvider pour l'API marchande Araka v1 (prod :
// https://api.arakapay.com, spec /swagger/v1/swagger.json) :
//   1. POST /v1/auth/token { publicKey, secretKey } → Bearer (3600 s)
//   2. POST /v1/createpaymentorder (+ Idempotency-Key) → push USSD/PIN
//      sur le téléphone de l'acheteur, qui valide l'achat lui-même
//   3. callback unique (non rejoué) sur redirectUrl, signé X-API-Signature
//   4. GET /v1/reporting/getstatusbyexternalreference/{ref} = source de vérité
// Aucune valeur de configuration n'est codée ici : tout vient des variables
// d'environnement (ARAKA_BASE_URL, ARAKA_PUBLIC_KEY, ARAKA_SECRET_KEY,
// ARAKA_WEBHOOK_SECRET, API_BASE_URL).
@Injectable()
export class ArakaV1Provider implements PaymentProvider {
  private readonly logger = new Logger(ArakaV1Provider.name);
  private readonly baseUrl: string;
  private readonly publicKey: string;
  private readonly secretKey: string;
  private readonly webhookSecret: string;

  private token?: string;
  private tokenExpiresAt = 0;
  private tokenPromise?: Promise<string>;
  // Nonces de callback déjà vus (anti-rejeu), purgés après la fenêtre de 5 min
  // — au-delà, l'horodatage suffit à rejeter. Mémoire locale : un rejeu qui
  // passerait après un redémarrage resterait inoffensif, la résolution du
  // paiement étant idempotente et re-vérifiée par checkStatus.
  private readonly seenNonces = new Map<string, number>();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.baseUrl = (this.config.get<string>('ARAKA_BASE_URL') ?? '')
      .trim()
      .replace(/\/+$/, '');
    this.publicKey = this.config.get<string>('ARAKA_PUBLIC_KEY') ?? '';
    this.secretKey = this.config.get<string>('ARAKA_SECRET_KEY') ?? '';
    this.webhookSecret = this.config.get<string>('ARAKA_WEBHOOK_SECRET') ?? '';
    if (!this.webhookSecret) {
      this.logger.warn(
        'ARAKA_WEBHOOK_SECRET absent : Araka n’enverra aucun callback et ceux reçus seront rejetés ; la confirmation reposera sur le reaper (checkStatus).',
      );
    }
  }

  async initPayment(input: InitPaymentInput): Promise<InitPaymentResult> {
    this.assertConfigured();
    if (!input.operator || !input.phoneNumber) {
      throw new Error(
        'Araka (Mobile Money) : `operator` et `phoneNumber` sont requis.',
      );
    }
    const operator = OPERATOR_ALIASES[input.operator.trim().toUpperCase()];
    if (!operator) {
      throw new Error(`Opérateur Araka inconnu (${input.operator}).`);
    }
    const wallet = this.msisdn(input.phoneNumber);
    const detected = PREFIX_TO_OPERATOR[wallet.slice(3, 5)];
    if (!wallet.startsWith('243') || wallet.length !== 12 || !detected) {
      throw new Error(
        'Numéro Mobile Money invalide : préfixe RDC non reconnu.',
      );
    }
    if (detected !== operator) {
      throw new Error(
        `Le numéro ne correspond pas à l’opérateur choisi (${operator}).`,
      );
    }

    const customer: Record<string, string> = {
      name: this.customerName(input.customerFullName),
      phone: input.customerPhone ? this.msisdn(input.customerPhone) : wallet,
    };
    if (input.customerEmail) customer.email = input.customerEmail;

    // Corps EXACT du schéma CreateMobileMoneyOrderRequest
    // (additionalProperties: false → aucun champ supplémentaire).
    const body = {
      externalReference: input.paymentRef,
      amount: this.formatAmount(input.amount, input.currency),
      currency: input.currency,
      redirectUrl: this.callbackUrl(input.redirectUrl),
      customer,
      walletId: wallet,
    };

    let res: Response;
    try {
      res = await this.authed('/v1/createpaymentorder', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Idempotency-Key': this.idempotencyKey(input.paymentRef) },
      });
    } catch (err) {
      throw this.unreachable('INIT', err);
    }
    const data = await this.readJson<Envelope<StatusData>>(res);
    await this.log(
      input.paymentRef,
      'INIT',
      body,
      data,
      data?.responseCode ?? res.status,
    );

    if (!res.ok) {
      const why = data?.responseDescription ?? `HTTP ${res.status}`;
      throw new Error(`Araka a refusé l'initiation du paiement (${why}).`);
    }
    // Push Mobile Money : pas de page de paiement, l'acheteur valide sur son
    // téléphone (demande de code PIN de l'opérateur).
    return { paymentRef: input.paymentRef };
  }

  async checkStatus(paymentRef: string): Promise<CheckStatusResult> {
    this.assertConfigured();
    let res: Response;
    try {
      res = await this.authed(
        `/v1/reporting/getstatusbyexternalreference/${encodeURIComponent(paymentRef)}`,
        { method: 'GET' },
      );
    } catch (err) {
      throw this.unreachable('CHECK', err);
    }
    const body = await this.readJson<Envelope<StatusData>>(res);
    await this.log(
      paymentRef,
      'CHECK',
      { ref: paymentRef },
      body,
      body?.responseCode ?? res.status,
    );

    // 404 : transaction pas (encore) connue → on attend, sans trancher.
    if (res.status === 404) return { status: 'PENDING' };
    // 200 Approved / 201 Pending / 422 Declined sont des réponses métier.
    if (![200, 201, 422].includes(res.status)) {
      throw new Error(`Araka statut: HTTP ${res.status}`);
    }

    const data = body?.data;
    const amount =
      data?.amount !== undefined && data.amount !== ''
        ? Number(data.amount)
        : undefined;
    return {
      status: this.mapStatus(res.status, data?.status ?? data?.statusName),
      amount:
        amount !== undefined && Number.isFinite(amount) ? amount : undefined,
      currency: this.asCurrency(data?.currency),
    };
  }

  // X-API-Signature = Base64(HMAC-SHA256(secret, corps brut)). Horodatage et
  // nonce ne sont PAS signés : on les contrôle à part (≤ 5 min, nonce unique).
  // Sans secret configuré → rejet systématique (fail-closed).
  verifyWebhookSignature(
    rawBody: string,
    headers: Record<string, string>,
  ): boolean {
    const reason = this.webhookRejection(rawBody, headers);
    if (reason) {
      // Rejet visible dans les logs (sinon un secret mal recopié passe
      // inaperçu : Araka ne rejoue pas le callback). Jamais le secret ni la
      // signature reçue dans le message.
      this.logger.warn(`Callback Araka rejeté : ${reason}`);
      return false;
    }
    return true;
  }

  // Renvoie la raison du rejet, ou null si le callback est authentique.
  private webhookRejection(
    rawBody: string,
    headers: Record<string, string>,
  ): string | null {
    if (!this.webhookSecret) {
      return 'ARAKA_WEBHOOK_SECRET absent sur le serveur.';
    }

    const signature = this.header(headers, 'x-api-signature') ?? '';
    const timestamp = Number(this.header(headers, 'x-api-timestamp'));
    const nonce = this.header(headers, 'x-api-nonce') ?? '';
    if (!signature || !nonce || !Number.isFinite(timestamp) || timestamp <= 0) {
      return 'en-tête X-API-Signature / X-API-Timestamp / X-API-Nonce manquant ou invalide.';
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (
      nowSec - timestamp > WEBHOOK_MAX_AGE_SEC ||
      timestamp - nowSec > WEBHOOK_MAX_SKEW_SEC
    ) {
      return `horodatage hors fenêtre (écart ${nowSec - timestamp} s, max ${WEBHOOK_MAX_AGE_SEC} s).`;
    }

    const expected = createHmac('sha256', this.webhookSecret)
      .update(rawBody, 'utf8')
      .digest();
    const presented = Buffer.from(signature, 'base64');
    if (
      presented.length !== expected.length ||
      !timingSafeEqual(presented, expected)
    ) {
      return 'signature invalide — vérifier que ARAKA_WEBHOOK_SECRET (Render) est identique au secret du portail Araka.';
    }

    // Nonce vérifié APRÈS la signature : un tiers ne peut pas « consommer » un
    // nonce légitime avec une requête forgée.
    this.pruneNonces(nowSec);
    if (this.seenNonces.has(nonce)) {
      return 'nonce déjà reçu (rejeu).';
    }
    this.seenNonces.set(nonce, timestamp + WEBHOOK_MAX_AGE_SEC);
    return null;
  }

  getOperators(): Promise<ProviderOperator[]> {
    return Promise.resolve(
      OPERATORS.map((op) => ({ ...op, currencies: [...op.currencies] })),
    );
  }

  private async authed(
    path: string,
    init: RequestInit,
    retry = true,
  ): Promise<Response> {
    const token = await this.bearer();
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(ARAKA_HTTP_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (res.status === 401 && retry) {
      this.token = undefined;
      this.tokenExpiresAt = 0;
      return this.authed(path, init, false);
    }
    return res;
  }

  private async bearer(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    if (!this.tokenPromise) {
      this.tokenPromise = this.fetchToken().finally(() => {
        this.tokenPromise = undefined;
      });
    }
    return this.tokenPromise;
  }

  private async fetchToken(): Promise<string> {
    let res: Response;
    try {
      // Pas d'en-tête Authorization sur cet appel (exigence de l'API).
      res = await fetch(`${this.baseUrl}/v1/auth/token`, {
        method: 'POST',
        signal: AbortSignal.timeout(ARAKA_HTTP_TIMEOUT_MS),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicKey: this.publicKey,
          secretKey: this.secretKey,
        }),
      });
    } catch (err) {
      throw this.unreachable('AUTH', err);
    }
    const data = await this.readJson<TokenResponse>(res);
    if (!res.ok || !data?.accessToken) {
      // Jamais de détail de clé dans le message ni dans les logs.
      throw new Error(
        `Araka a refusé l'authentification (HTTP ${res.status}).`,
      );
    }
    this.token = data.accessToken;
    const expiresInSec = Number(data.expiresIn);
    this.tokenExpiresAt =
      Number.isFinite(expiresInSec) && expiresInSec > 120
        ? Date.now() + (expiresInSec - 60) * 1000
        : Date.now() + TOKEN_FALLBACK_TTL_MS;
    return this.token;
  }

  private assertConfigured(): void {
    const missing = [
      ['ARAKA_BASE_URL', this.baseUrl],
      ['ARAKA_PUBLIC_KEY', this.publicKey],
      ['ARAKA_SECRET_KEY', this.secretKey],
    ]
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length) {
      throw new Error(
        `Configuration Araka v1 incomplète (${missing.join(', ')}).`,
      );
    }
  }

  // Clé d'idempotence DÉTERMINISTE (format UUID) dérivée de notre référence :
  // un réessai de la même commande ne peut pas déclencher un second débit.
  private idempotencyKey(paymentRef: string): string {
    const h = createHash('sha256').update(`vybe:${paymentRef}`).digest('hex');
    return [
      h.slice(0, 8),
      h.slice(8, 12),
      `4${h.slice(13, 16)}`,
      `${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}`,
      h.slice(20, 32),
    ].join('-');
  }

  // MSISDN RDC, chiffres seuls, préfixe pays 243. Accepte 243…, +243…, 0…, ou 9 chiffres.
  private msisdn(raw: string): string {
    let digits = raw.replace(/\D/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (digits.startsWith('0') && digits.length === 10) {
      digits = `243${digits.slice(1)}`;
    } else if (digits.length === 9) {
      digits = `243${digits}`;
    }
    return digits;
  }

  private customerName(name?: string): string {
    const clean = name?.trim();
    return clean ? clean.slice(0, 80) : 'Client Vybe';
  }

  // URL de callback (= redirectUrl v1). Doit être en https et son hôte doit
  // figurer dans « Callback domains » du portail Araka.
  private callbackUrl(explicit?: string): string {
    const base = (this.config.get<string>('API_BASE_URL') ?? '').replace(
      /\/+$/,
      '',
    );
    const url = explicit || (base ? `${base}/payments/webhook` : '');
    if (!url) {
      throw new Error(
        'API_BASE_URL manquant : impossible de construire le callback Araka.',
      );
    }
    if (!/^https:\/\//i.test(url)) {
      throw new Error('Araka v1 exige une URL de callback en https.');
    }
    return url;
  }

  private mapStatus(httpStatus: number, text?: string): ProviderStatus {
    const t = (text ?? '').trim().toUpperCase();
    if (t === 'APPROVED') return 'APPROVED';
    if (t === 'DECLINED') return 'DECLINED';
    if (t === 'PENDING') return 'PENDING';
    if (httpStatus === 200) return 'APPROVED';
    if (httpStatus === 422) return 'DECLINED';
    // Inconnu → PENDING : on ne solde jamais à tort.
    return 'PENDING';
  }

  private asCurrency(value?: string): ProviderCurrency | undefined {
    if (value === 'USD' || value === 'CDF') return value;
    return undefined;
  }

  private formatAmount(amount: number, currency: ProviderCurrency): number {
    if (currency === 'CDF') return Math.round(amount);
    return Number(amount.toFixed(2));
  }

  private pruneNonces(nowSec: number): void {
    for (const [n, expiresAt] of this.seenNonces) {
      if (expiresAt < nowSec) this.seenNonces.delete(n);
    }
  }

  private header(
    headers: Record<string, string>,
    name: string,
  ): string | undefined {
    const target = name.toLowerCase();
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === target) return headers[key];
    }
    return undefined;
  }

  private async readJson<T>(res: Response): Promise<T | undefined> {
    try {
      return (await res.json()) as T;
    } catch {
      return undefined;
    }
  }

  private unreachable(direction: string, err: unknown): Error {
    const timeout = err instanceof Error && err.name === 'TimeoutError';
    this.logger.error(
      `${direction} fetch a échoué${timeout ? ' (timeout)' : ''}: ${String(err)}`,
    );
    return new Error(
      timeout
        ? `Araka injoignable (${direction}, timeout).`
        : `Araka injoignable (${direction}).`,
    );
  }

  private async log(
    paymentRef: string,
    direction: string,
    requestBody: unknown,
    responseBody: unknown,
    status?: string | number,
  ): Promise<void> {
    try {
      await this.prisma.paymentProviderLog.create({
        data: {
          paymentRef,
          direction,
          requestBody: requestBody ?? Prisma.JsonNull,
          responseBody: responseBody ?? Prisma.JsonNull,
          status: status !== undefined ? String(status) : undefined,
        },
      });
    } catch (err) {
      this.logger.warn(`PaymentProviderLog non écrit: ${String(err)}`);
    }
  }
}
