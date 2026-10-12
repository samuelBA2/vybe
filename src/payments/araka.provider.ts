import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { timingSafeEqual } from 'crypto';
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

// Réponse Araka à POST /api/login.
interface ArakaLoginResponse {
  token?: string;
  expiresIn?: number;
  expires_in?: number;
}

// Réponse Araka à POST /api/pay/paymentrequest et /api/pay/sendmobilemoney.
// statusCode 202 = accepté (USSD ou page), 200 = déjà abouti. `paymentPage`
// est une URL de checkout quand le canal n'est pas un simple push.
interface ArakaPaymentResponse {
  originatingTransactionId?: string;
  statusCode?: string | number;
  statusDescription?: string;
  transactionId?: string | number;
  paymentPage?: string | null;
}

// Réponse Araka à GET /api/reporting/transactionstatusbyreference/{ref}.
interface ArakaStatusResponse {
  statusCode?: string | number;
  status?: string;
  transactionId?: string | number;
  transactionDate?: string;
  amount?: number | string;
  currency?: string;
}

// Codes opérateur Araka (RDC). Les alias PawaPay sont acceptés à l'initiation
// pour qu'un client encore sur les anciens codes reste compréhensible ; la
// liste exposée au front (getOperators) n'annonce que les codes Araka.
const OPERATOR_TO_ARAKA: Record<string, string> = {
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
  { code: 'MPESA', name: 'Vodacom M-Pesa', available: true, currencies: ['USD', 'CDF'] },
  { code: 'AIRTEL', name: 'Airtel Money', available: true, currencies: ['USD', 'CDF'] },
  { code: 'ORANGE', name: 'Orange Money', available: true, currencies: ['USD', 'CDF'] },
  { code: 'AFRIMONEY', name: 'Afrimoney', available: true, currencies: ['USD', 'CDF'] },
];

const SUCCESS_TEXT = new Set([
  'APPROVED',
  'SUCCESS',
  'SUCCESSFUL',
  'COMPLETED',
  'PAID',
  'OK',
]);
const FAILURE_TEXT = new Set([
  'DECLINED',
  'FAILED',
  'REJECTED',
  'CANCELLED',
  'CANCELED',
  'ERROR',
]);

// Jeton Araka : l'intégration Oasis le considère valable 115 minutes
// (le jeton serveur dure ~2 h ; on rafraîchit avant l'échéance).
const TOKEN_TTL_MS = 115 * 60_000;

// Implémentation PaymentProvider pour Araka (agrégateur Mobile Money RDC).
// Reprend le flux de l'intégration Oasis :
//   1. POST /api/login { emailAddress, password } → Bearer
//   2. POST /api/pay/paymentrequest { order, paymentChannel: MOBILEMONEY }
//   3. callback { originatingTransactionId, statusCode, statusDescription }
//   4. GET /api/reporting/transactionstatusbyreference/{transactionReference}
// Le callback n'est pas signé chez Araka : l'argent ne bouge qu'après checkStatus.
@Injectable()
export class ArakaProvider implements PaymentProvider {
  private readonly logger = new Logger(ArakaProvider.name);
  private readonly baseUrl: string;
  private readonly email: string;
  private readonly password: string;
  private readonly pageId: string;
  private readonly loginPath: string;
  private readonly paymentPath: string;
  private readonly statusPath: string;

  private token?: string;
  private tokenExpiresAt = 0;
  private loginPromise?: Promise<string>;
  private warnedUnsignedWebhook = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.baseUrl = (this.config.get<string>('ARAKA_BASE_URL') ?? '').replace(
      /\/+$/,
      '',
    );
    this.email = this.config.get<string>('ARAKA_EMAIL') ?? '';
    this.password = this.config.get<string>('ARAKA_PASSWORD') ?? '';
    this.pageId = this.config.get<string>('ARAKA_PAYMENT_PAGE_ID') ?? '';
    this.loginPath = this.path('ARAKA_LOGIN_PATH', '/api/login');
    this.paymentPath = this.path(
      'ARAKA_PAYMENT_PATH',
      '/api/pay/paymentrequest',
    );
    this.statusPath = this.path(
      'ARAKA_STATUS_PATH',
      '/api/reporting/transactionstatusbyreference',
    );
  }

  async initPayment(input: InitPaymentInput): Promise<InitPaymentResult> {
    this.assertConfigured();
    if (!input.operator || !input.phoneNumber) {
      throw new Error(
        'Araka (Mobile Money) : `operator` et `phoneNumber` sont requis.',
      );
    }
    const provider = this.toArakaOperator(input.operator);
    if (!provider) {
      throw new Error(`Opérateur Araka inconnu (${input.operator}).`);
    }

    const wallet = this.msisdn(input.phoneNumber);
    const redirectURL = this.callbackUrl(input.redirectUrl);
    const body = {
      order: {
        paymentPageId: this.pageId,
        customerFullName: this.customerName(input.customerFullName),
        customerPhoneNumber: this.msisdn(input.customerPhone || wallet),
        customerEmailAddress: input.customerEmail || undefined,
        transactionReference: input.paymentRef,
        amount: this.formatAmount(input.amount, input.currency),
        currency: input.currency,
        redirectURL,
      },
      paymentChannel: {
        channel: 'MOBILEMONEY',
        provider,
        // Oasis envoie `walletId` ; la collection Postman documente `walletID`.
        // Les deux sont posés pour rester compatible avec les deux contrats.
        walletId: wallet,
        walletID: wallet,
      },
    };

    const data = await this.postJson<ArakaPaymentResponse>(
      this.paymentPath,
      body,
      input.paymentRef,
      'INIT',
    );

    if (!this.accepted(data?.statusCode)) {
      const code = data?.statusCode ?? data?.statusDescription ?? 'INCONNU';
      throw new Error(`Araka a refusé l'initiation du paiement (${code}).`);
    }

    const page = data?.paymentPage?.trim();
    const paymentUrl =
      page && /^https?:\/\//i.test(page) ? page : undefined;
    return { paymentRef: input.paymentRef, paymentUrl };
  }

  async checkStatus(paymentRef: string): Promise<CheckStatusResult> {
    return this.inquire(paymentRef, 'CHECK');
  }

  // Araka ne signe pas ses callbacks (l'intégration Oasis les accepte tels quels).
  // Si `ARAKA_WEBHOOK_SECRET` est défini, le header `x-araka-secret` doit le
  // reprendre (comparaison en temps constant). Sans secret, on accepte : le
  // service re-vérifie ensuite via checkStatus, qui reste la source de vérité.
  verifyWebhookSignature(
    _rawBody: string,
    headers: Record<string, string>,
  ): boolean {
    const secret = this.config.get<string>('ARAKA_WEBHOOK_SECRET') ?? '';
    if (!secret) {
      if (!this.warnedUnsignedWebhook) {
        this.warnedUnsignedWebhook = true;
        this.logger.warn(
          'ARAKA_WEBHOOK_SECRET absent : callbacks Araka acceptés sans signature (la confirmation reste checkStatus).',
        );
      }
      return true;
    }
    const presented =
      this.header(headers, 'x-araka-secret') ??
      this.header(headers, 'x-webhook-secret') ??
      '';
    const a = Buffer.from(presented);
    const b = Buffer.from(secret);
    if (a.length !== b.length || a.length === 0) return false;
    return timingSafeEqual(a, b);
  }

  getOperators(): Promise<ProviderOperator[]> {
    return Promise.resolve(OPERATORS.map((op) => ({ ...op, currencies: [...op.currencies] })));
  }

  private async inquire(
    ref: string,
    direction: string,
  ): Promise<CheckStatusResult> {
    this.assertConfigured();
    let res: Response;
    try {
      res = await this.authed(
        `${this.statusPath}/${encodeURIComponent(ref)}`,
        { method: 'GET' },
      );
    } catch (err) {
      const timeout = err instanceof Error && err.name === 'TimeoutError';
      this.logger.error(
        `${direction} fetch a échoué${timeout ? ' (timeout)' : ''}: ${String(err)}`,
      );
      throw new Error(
        timeout
          ? 'Araka injoignable (statut, timeout).'
          : 'Araka injoignable (statut).',
      );
    }

    let body: ArakaStatusResponse | undefined;
    try {
      body = (await res.json()) as ArakaStatusResponse;
    } catch {
      body = undefined;
    }
    await this.log(ref, direction, { ref }, body, body?.statusCode ?? body?.status);

    if (res.status === 404) return { status: 'PENDING' };
    if (!res.ok) throw new Error(`Araka statut: HTTP ${res.status}`);

    const amount =
      body?.amount !== undefined && body.amount !== ''
        ? Number(body.amount)
        : undefined;
    const currency = this.asCurrency(body?.currency);
    return {
      status: this.mapStatus(body?.statusCode, body?.status),
      amount: amount !== undefined && Number.isFinite(amount) ? amount : undefined,
      currency,
    };
  }

  private async postJson<T>(
    path: string,
    body: unknown,
    ref: string,
    direction: string,
  ): Promise<T | undefined> {
    let res: Response;
    try {
      res = await this.authed(path, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    } catch (err) {
      const timeout = err instanceof Error && err.name === 'TimeoutError';
      this.logger.error(
        `${direction} fetch a échoué${timeout ? ' (timeout)' : ''}: ${String(err)}`,
      );
      throw new Error(
        timeout ? 'Araka injoignable (timeout).' : 'Araka injoignable.',
      );
    }

    let data: T | undefined;
    try {
      data = (await res.json()) as T;
    } catch {
      data = undefined;
    }
    const statusCode = (data as ArakaPaymentResponse | undefined)?.statusCode;
    await this.log(ref, direction, body, data, statusCode ?? String(res.status));

    if (!res.ok && !this.accepted(statusCode)) {
      throw new Error(`Araka ${direction}: HTTP ${res.status}`);
    }
    return data;
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
    if (!this.loginPromise) {
      this.loginPromise = this.login().finally(() => {
        this.loginPromise = undefined;
      });
    }
    return this.loginPromise;
  }

  private async login(): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${this.loginPath}`, {
        method: 'POST',
        signal: AbortSignal.timeout(ARAKA_HTTP_TIMEOUT_MS),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailAddress: this.email,
          password: this.password,
        }),
      });
    } catch (err) {
      const timeout = err instanceof Error && err.name === 'TimeoutError';
      this.logger.error(
        `login fetch a échoué${timeout ? ' (timeout)' : ''}: ${String(err)}`,
      );
      throw new Error(
        timeout
          ? 'Araka injoignable (login, timeout).'
          : 'Araka injoignable (login).',
      );
    }
    let data: ArakaLoginResponse | undefined;
    try {
      data = (await res.json()) as ArakaLoginResponse;
    } catch {
      data = undefined;
    }
    if (!res.ok || !data?.token) {
      throw new Error('Araka a refusé le login.');
    }
    this.token = data.token;
    const expiresInSec = Number(data.expiresIn ?? data.expires_in);
    this.tokenExpiresAt =
      Number.isFinite(expiresInSec) && expiresInSec > 120
        ? Date.now() + (expiresInSec - 60) * 1000
        : Date.now() + TOKEN_TTL_MS;
    return this.token;
  }

  private assertConfigured(): void {
    if (!this.baseUrl || !this.email || !this.password || !this.pageId) {
      throw new Error(
        'Configuration Araka incomplète (ARAKA_BASE_URL, ARAKA_EMAIL, ARAKA_PASSWORD, ARAKA_PAYMENT_PAGE_ID).',
      );
    }
  }

  private path(envKey: string, fallback: string): string {
    const raw = (this.config.get<string>(envKey) ?? fallback).trim();
    return raw.startsWith('/') ? raw : `/${raw}`;
  }

  private toArakaOperator(code: string): string | undefined {
    return OPERATOR_TO_ARAKA[code.trim().toUpperCase()];
  }

  // MSISDN RDC, chiffres seuls, préfixe pays 243. Accepte 243…, 0…, ou 9 chiffres.
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

  private callbackUrl(explicit?: string): string {
    if (explicit && /^https?:\/\//i.test(explicit)) return explicit;
    const base = (this.config.get<string>('API_BASE_URL') ?? '').replace(
      /\/+$/,
      '',
    );
    if (!base) {
      throw new Error(
        'API_BASE_URL manquant : impossible de construire le callback Araka.',
      );
    }
    return `${base}/payments/webhook`;
  }

  private accepted(statusCode?: string | number): boolean {
    const code = String(statusCode ?? '');
    return code === '200' || code === '202';
  }

  // 200 / texte de succès → APPROVED ; 202 → PENDING ; autre code ou texte
  // d'échec → DECLINED. Inconnu → PENDING (on ne solde jamais à tort).
  private mapStatus(
    statusCode?: string | number,
    status?: string,
  ): ProviderStatus {
    const text = (status ?? '').trim().toUpperCase();
    if (SUCCESS_TEXT.has(text)) return 'APPROVED';
    if (FAILURE_TEXT.has(text)) return 'DECLINED';
    const code = String(statusCode ?? '').trim();
    if (code === '200') return 'APPROVED';
    if (code === '202') return 'PENDING';
    if (code) return 'DECLINED';
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
