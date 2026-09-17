import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { PAWAPAY_OPERATORS_CACHE_TTL_MS } from 'src/common/constants';
import {
  CheckStatusResult,
  InitPaymentInput,
  InitPaymentResult,
  InitPayoutInput,
  InitPayoutResult,
  PaymentProvider,
  ProviderCurrency,
  ProviderOperator,
  WebhookRequestContext,
} from './payment-provider.interface';

// Forme (partielle) de la réponse PawaPay à POST /v2/deposits.
interface PawaPayDepositResponse {
  depositId?: string;
  status?: string; // ACCEPTED | REJECTED | DUPLICATE_IGNORED
  created?: string;
  failureReason?: { failureCode?: string; failureMessage?: string };
}

// Forme (partielle) de la réponse à GET /v2/deposits/{id} (enveloppée).
interface PawaPayStatusResponse {
  status?: string; // FOUND | NOT_FOUND
  data?: {
    depositId?: string;
    status?: string; // COMPLETED | FAILED | PROCESSING
    amount?: string;
    currency?: string;
    providerTransactionId?: string;
  };
}

// Forme (partielle) de la réponse PawaPay à POST /v2/payouts.
interface PawaPayPayoutResponse {
  payoutId?: string;
  status?: string; // ACCEPTED | REJECTED | DUPLICATE_IGNORED
  failureReason?: { failureCode?: string; failureMessage?: string };
}
// Forme (partielle) de la réponse à GET /v2/payouts/{id} (enveloppée).
interface PawaPayPayoutStatusResponse {
  status?: string; // FOUND | NOT_FOUND
  data?: {
    payoutId?: string;
    status?: string; // COMPLETED | FAILED | PROCESSING
    amount?: string;
    currency?: string;
  };
}

// Forme (partielle) de GET /v2/active-conf.
interface PawaPayActiveConf {
  countries?: Array<{
    country?: string;
    providers?: Array<{
      provider: string;
      displayName?: string;
      logo?: string;
      currencies?: Array<{
        currency?: string;
        operationTypes?: { DEPOSIT?: { status?: string } };
      }>;
    }>;
  }>;
}

// Implémentation concrète du PaymentProvider pour PawaPay (agrégateur Mobile Money
// RDC : Vodacom, Airtel, Orange). Modèle PUSH : on pousse la demande, l'acheteur
// valide par USSD/PIN sur son téléphone, puis callback + re-vérification serveur.
// Doc : POST {BASE_URL}/v2/deposits, auth Bearer, idempotent par depositId.
// Sandbox et prod ne diffèrent que par PAWAPAY_BASE_URL + PAWAPAY_API_TOKEN.
//
// Task 3b — état : initPayment implémenté. checkStatus + verifyWebhookSignature
// = étapes suivantes de la 3b (stubbés ci-dessous).
@Injectable()
export class PawaPayProvider implements PaymentProvider {
  private readonly logger = new Logger(PawaPayProvider.name);
  private readonly baseUrl: string;
  private readonly token: string;

  // Cache mémoire (process, instance = singleton Nest) du résultat de
  // getOperators(). On cache la PROMESSE (pas juste la valeur) pour aussi
  // collapser les appels concurrents (rafale) en un seul fetch upstream. Un
  // échec n'est JAMAIS mis en cache (voir catch dans getOperators) : le
  // prochain appel retente immédiatement.
  private operatorsCache?: Promise<ProviderOperator[]>;
  private operatorsCacheExpiresAt = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    // Sans slash final : on concatène des chemins '/v2/...'.
    this.baseUrl = (
      this.config.get<string>('PAWAPAY_BASE_URL') ??
      'https://api.sandbox.pawapay.io'
    ).replace(/\/+$/, '');
    this.token = this.config.get<string>('PAWAPAY_API_TOKEN') ?? '';
  }

  async initPayment(input: InitPaymentInput): Promise<InitPaymentResult> {
    // PawaPay est PUSH : opérateur + numéro sont obligatoires. Contrôle AVANT
    // tout appel réseau (échec propre, aucun log/appel inutile).
    if (!input.operator || !input.phoneNumber) {
      throw new Error(
        'PawaPay (push Mobile Money) : `operator` et `phoneNumber` sont requis.',
      );
    }

    // depositId = notre paymentRef (UUIDv4 attendu par PawaPay, 36 car.).
    const depositId = input.paymentRef;
    const body: Record<string, unknown> = {
      depositId,
      payer: {
        type: 'MMO',
        accountDetails: {
          phoneNumber: input.phoneNumber,
          provider: input.operator,
        },
      },
      amount: this.formatAmount(input.amount, input.currency),
      currency: input.currency,
    };
    const customerMessage = this.sanitizeMessage(input.description);
    if (customerMessage) body.customerMessage = customerMessage;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v2/deposits`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Panne réseau : rien à auditer côté réponse, on relaie l'échec.
      this.logger.error(`initPayment fetch a échoué: ${String(err)}`);
      throw new Error('PawaPay injoignable (initPayment).');
    }

    let data: PawaPayDepositResponse | undefined;
    try {
      data = (await res.json()) as PawaPayDepositResponse;
    } catch {
      data = undefined;
    }

    // Audit (ne doit JAMAIS casser le paiement).
    await this.log(
      depositId,
      'INIT',
      body,
      data,
      data?.status ?? String(res.status),
    );

    if (!res.ok) {
      throw new Error(`PawaPay initPayment: HTTP ${res.status}`);
    }

    const status = data?.status;
    // ACCEPTED = pris en charge ; DUPLICATE_IGNORED = même depositId déjà initié
    // (idempotence) → on considère l'init réussie.
    if (status === 'ACCEPTED' || status === 'DUPLICATE_IGNORED') {
      // Push : pas de paymentUrl. On renvoie notre référence.
      return { paymentRef: data?.depositId ?? depositId };
    }

    // REJECTED (ou statut inattendu) : l'init a échoué → createOrder marquera
    // FAILED + relâchera le stock.
    const code = data?.failureReason?.failureCode ?? status ?? 'INCONNU';
    throw new Error(`PawaPay a refusé l'initiation du paiement (${code}).`);
  }

  // Re-vérifie le statut d'un dépôt côté serveur = SOURCE DE VÉRITÉ (jamais le seul
  // callback). Doc : GET {BASE_URL}/v2/deposits/{depositId}. Réponse enveloppée :
  //   { status: 'FOUND' | 'NOT_FOUND', data?: { status: 'COMPLETED'|'FAILED'|'PROCESSING', ... } }
  async checkStatus(paymentRef: string): Promise<CheckStatusResult> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v2/deposits/${paymentRef}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.token}` },
      });
    } catch (err) {
      this.logger.error(`checkStatus fetch a échoué: ${String(err)}`);
      throw new Error('PawaPay injoignable (checkStatus).');
    }

    let body: PawaPayStatusResponse | undefined;
    try {
      body = (await res.json()) as PawaPayStatusResponse;
    } catch {
      body = undefined;
    }

    await this.log(paymentRef, 'CHECK', { paymentRef }, body, body?.status);

    if (!res.ok) {
      throw new Error(`PawaPay checkStatus: HTTP ${res.status}`);
    }

    // NOT_FOUND = paiement pas (encore) connu de PawaPay → on ne tranche pas.
    const deposit = body?.data;
    if (body?.status !== 'FOUND' || !deposit) {
      return { status: 'PENDING' };
    }

    // Mapping vers notre vocabulaire normalisé.
    const status = this.mapDepositStatus(deposit.status);
    const amount =
      deposit.amount !== undefined ? Number(deposit.amount) : undefined;
    const currency = deposit.currency as ProviderCurrency | undefined;
    return { status, amount, currency };
  }

  // Récupère la configuration active PawaPay et en dérive les opérateurs Mobile
  // Money RDC (pays 'COD') proposant le DÉPÔT. `available`/`currencies` sont mis
  // en cache un court instant (voir `fetchOperators`) : `GET /payments/config`
  // est un endpoint PUBLIC appelé à chaque chargement du checkout, on évite donc
  // de taper PawaPay à chaque requête.
  async getOperators(): Promise<ProviderOperator[]> {
    if (this.operatorsCache && Date.now() < this.operatorsCacheExpiresAt) {
      return this.operatorsCache;
    }

    const promise = this.fetchOperators();
    this.operatorsCache = promise;
    this.operatorsCacheExpiresAt = Date.now() + PAWAPAY_OPERATORS_CACHE_TTL_MS;
    // Un échec ne doit JAMAIS rester en cache : on efface aussitôt pour que le
    // prochain appel retente un fetch upstream (pas de panne figée).
    promise.catch(() => {
      if (this.operatorsCache === promise) {
        this.operatorsCache = undefined;
        this.operatorsCacheExpiresAt = 0;
      }
    });
    return promise;
  }

  // Corps réel de l'appel PawaPay /v2/active-conf, isolé de getOperators() pour
  // que celle-ci ne porte que la logique de cache.
  //
  // Dispo PAR DEVISE : un opérateur reste listé dès qu'il propose ≥1 devise en
  // DÉPÔT (même toutes CLOSED, pour que le front l'affiche grisé), mais
  // `currencies` ne contient que celles RÉELLEMENT utilisables maintenant
  // (DEPOSIT.status ≠ CLOSED). `available = currencies.length > 0` : un
  // opérateur mixte (ex. USD=OPERATIONAL, CDF=CLOSED) reste `available` mais
  // n'annonce QUE l'USD — sinon PawaPay rejetterait une init en CDF pourtant
  // affichée comme possible.
  private async fetchOperators(): Promise<ProviderOperator[]> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v2/active-conf`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.token}` },
      });
    } catch (err) {
      this.logger.error(`getOperators fetch a échoué: ${String(err)}`);
      throw new Error('PawaPay injoignable (active-conf).');
    }

    let body: PawaPayActiveConf | undefined;
    try {
      body = (await res.json()) as PawaPayActiveConf;
    } catch {
      body = undefined;
    }
    await this.log('active-conf', 'CONF', {}, body, String(res.status));

    if (!res.ok) {
      throw new Error(`PawaPay active-conf: HTTP ${res.status}`);
    }

    const cod = body?.countries?.find((c) => c.country === 'COD');
    const operators: ProviderOperator[] = [];
    for (const p of cod?.providers ?? []) {
      const depositEntries = (p.currencies ?? []).filter(
        (c) => !!c.operationTypes?.DEPOSIT,
      );
      if (depositEntries.length === 0) continue; // pas de dépôt possible : exclu

      const currencies = depositEntries
        .filter((c) => c.operationTypes?.DEPOSIT?.status !== 'CLOSED')
        .map((c) => c.currency)
        .filter((c): c is ProviderCurrency => c === 'USD' || c === 'CDF');

      operators.push({
        code: p.provider,
        name: p.displayName ?? p.provider,
        available: currencies.length > 0,
        logoUrl: p.logo,
        currencies,
      });
    }
    return operators;
  }

  // Décaissement Mobile Money. Doc : POST {BASE_URL}/v2/payouts (miroir des dépôts,
  // recipient au lieu de payer). Idempotent par payoutId. ACCEPTED/DUPLICATE_IGNORED
  // → PENDING (résolution async) ; REJECTED → DECLINED.
  async initPayout(input: InitPayoutInput): Promise<InitPayoutResult> {
    const payoutId = input.payoutRef;
    const body: Record<string, unknown> = {
      payoutId,
      recipient: {
        type: 'MMO',
        accountDetails: {
          phoneNumber: input.phoneNumber,
          provider: input.operator,
        },
      },
      amount: this.formatAmount(input.amount, input.currency),
      currency: input.currency,
    };
    const customerMessage = this.sanitizeMessage(input.description);
    if (customerMessage) body.customerMessage = customerMessage;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v2/payouts`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      this.logger.error(`initPayout fetch a échoué: ${String(err)}`);
      throw new Error('PawaPay injoignable (initPayout).');
    }

    let data: PawaPayPayoutResponse | undefined;
    try {
      data = (await res.json()) as PawaPayPayoutResponse;
    } catch {
      data = undefined;
    }
    await this.log(
      payoutId,
      'PAYOUT_INIT',
      body,
      data,
      data?.status ?? String(res.status),
    );

    if (!res.ok) throw new Error(`PawaPay initPayout: HTTP ${res.status}`);

    const status = data?.status;
    if (status === 'ACCEPTED' || status === 'DUPLICATE_IGNORED') {
      return {
        payoutRef: data?.payoutId ?? payoutId,
        providerPayoutId: data?.payoutId,
        status: 'PENDING',
      };
    }
    // REJECTED / inattendu : init refusée.
    return { payoutRef: payoutId, status: 'DECLINED' };
  }

  // Re-vérifie un payout côté serveur = SOURCE DE VÉRITÉ. GET {BASE_URL}/v2/payouts/{id}
  // (enveloppé FOUND/NOT_FOUND). COMPLETED→APPROVED, FAILED→DECLINED, sinon PENDING.
  async checkPayoutStatus(payoutRef: string): Promise<CheckStatusResult> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v2/payouts/${payoutRef}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.token}` },
      });
    } catch (err) {
      this.logger.error(`checkPayoutStatus fetch a échoué: ${String(err)}`);
      throw new Error('PawaPay injoignable (checkPayoutStatus).');
    }

    let body: PawaPayPayoutStatusResponse | undefined;
    try {
      body = (await res.json()) as PawaPayPayoutStatusResponse;
    } catch {
      body = undefined;
    }
    await this.log(
      payoutRef,
      'PAYOUT_CHECK',
      { payoutRef },
      body,
      body?.status,
    );

    if (!res.ok)
      throw new Error(`PawaPay checkPayoutStatus: HTTP ${res.status}`);

    const payout = body?.data;
    if (body?.status !== 'FOUND' || !payout) return { status: 'PENDING' };

    const status = this.mapDepositStatus(payout.status); // même mapping COMPLETED/FAILED
    const amount =
      payout.amount !== undefined ? Number(payout.amount) : undefined;
    const currency = payout.currency as ProviderCurrency | undefined;
    return { status, amount, currency };
  }

  // Vérifie l'authenticité d'un callback PawaPay (RFC-9421, ecdsa-p256-sha256).
  // FAIL-CLOSED : tout doute (header manquant, clé absente, digest ou signature
  // invalide, composant non résolvable) → false. Le webhook re-vérifie de toute
  // façon via checkStatus, mais on ne traite JAMAIS un callback non authentifié.
  //
  // NOTE : la clé publique PawaPay est ici lue depuis l'env PAWAPAY_PUBLIC_KEY.
  // À terme, la récupérer par `keyid` via le Public Keys endpoint (rotation).
  //
  // `context` (méthode/chemin/authority) permet de résoudre les composants DÉRIVÉS
  // @method/@path/@authority signés par PawaPay en PRODUCTION. Sans lui, une
  // signature qui les couvre est rejetée (fail-closed).
  verifyWebhookSignature(
    rawBody: string,
    headers: Record<string, string>,
    context?: WebhookRequestContext,
  ): boolean {
    try {
      const digestHeader = this.header(headers, 'content-digest');
      const sigInput = this.header(headers, 'signature-input');
      const sigHeader = this.header(headers, 'signature');
      if (!digestHeader || !sigInput || !sigHeader) return false;

      // 1) Intégrité du corps : recalcule le Content-Digest et compare.
      if (!this.verifyContentDigest(rawBody, digestHeader)) return false;

      // 2) Clé publique attendue (fail-closed si absente).
      const pem = this.config.get<string>('PAWAPAY_PUBLIC_KEY');
      if (!pem) {
        this.logger.warn('PAWAPAY_PUBLIC_KEY absente : callback rejeté.');
        return false;
      }

      // 3) Reconstruit la base de signature (RFC-9421 §2.5) puis vérifie l'ECDSA.
      const parsed = this.parseSignatureInput(sigInput);
      if (!parsed) return false;
      const signature = this.extractSignature(sigHeader, parsed.label);
      if (!signature) return false;

      const base = this.buildSignatureBase(headers, parsed, context);
      if (base === null) return false; // composant non résolvable → fail-closed

      return cryptoVerify(
        'sha256',
        Buffer.from(base),
        { key: createPublicKey(pem), dsaEncoding: 'ieee-p1363' },
        signature,
      );
    } catch (err) {
      this.logger.warn(`verifyWebhookSignature a échoué: ${String(err)}`);
      return false;
    }
  }

  // Lecture d'un header insensible à la casse (Nest les passe en minuscules,
  // mais on se protège quand même).
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

  // Recalcule le Content-Digest (RFC-9530) du corps brut et le compare au header.
  // Format : `sha-512=:<base64>:` (éventuellement plusieurs, séparés par des virgules).
  private verifyContentDigest(rawBody: string, digestHeader: string): boolean {
    const entries = digestHeader.split(',');
    for (const entry of entries) {
      const m = /^\s*(sha-256|sha-512)=:(.+):\s*$/.exec(entry);
      if (!m) continue;
      const algo = m[1] === 'sha-512' ? 'sha512' : 'sha256';
      const expected = m[2];
      const actual = createHash(algo).update(rawBody).digest('base64');
      if (actual === expected) return true;
    }
    return false;
  }

  // Parse le header Signature-Input : `label=("comp1" "comp2");p1=..;keyid="..";alg="..".
  // Renvoie le label, la liste des composants couverts, et la chaîne de params
  // EXACTE (réutilisée telle quelle pour la ligne @signature-params).
  private parseSignatureInput(
    value: string,
  ): { label: string; components: string[]; params: string } | null {
    const eq = value.indexOf('=');
    if (eq < 0) return null;
    const label = value.slice(0, eq).trim();
    const params = value.slice(eq + 1).trim();
    const open = params.indexOf('(');
    const close = params.indexOf(')');
    if (open < 0 || close < 0 || close < open) return null;
    const inner = params.slice(open + 1, close);
    const components = [...inner.matchAll(/"([^"]*)"/g)].map((x) => x[1]);
    return { label, components, params };
  }

  // Extrait la signature base64 du header Signature pour le label donné :
  // `label=:<base64>:`.
  private extractSignature(sigHeader: string, label: string): Buffer | null {
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`${esc}=:([^:]+):`).exec(sigHeader);
    if (!m) return null;
    return Buffer.from(m[1], 'base64');
  }

  // Construit la base de signature (RFC-9421 §2.5) à partir des composants couverts.
  // Composants issus des HEADERS résolus directement ; composants DÉRIVÉS (@method,
  // @path, @authority, @query) résolus depuis `context` (fourni par le contrôleur
  // depuis la requête). Tout composant non résolvable (contexte absent, ou dérivé
  // non supporté) → null (fail-closed).
  private buildSignatureBase(
    headers: Record<string, string>,
    parsed: { components: string[]; params: string },
    context?: WebhookRequestContext,
  ): string | null {
    const lines: string[] = [];
    for (const comp of parsed.components) {
      const val = comp.startsWith('@')
        ? this.resolveDerived(comp, context)
        : this.header(headers, comp);
      if (val === undefined) return null; // non résolvable → fail-closed
      lines.push(`"${comp}": ${val}`);
    }
    lines.push(`"@signature-params": ${parsed.params}`);
    return lines.join('\n');
  }

  // Résout un composant DÉRIVÉ RFC-9421 (§2.2) depuis le contexte requête. On ne
  // supporte que ceux effectivement signés par PawaPay ; tout autre → undefined
  // (fail-closed). @method majuscule, @authority minuscule, @query préfixée de '?'
  // (ou '?' seul si vide), conformément à la spec.
  private resolveDerived(
    comp: string,
    context?: WebhookRequestContext,
  ): string | undefined {
    if (!context) return undefined;
    switch (comp) {
      case '@method':
        return context.method.toUpperCase();
      case '@authority':
        return context.authority.toLowerCase();
      case '@path':
        return context.path;
      case '@query':
        return context.query ? `?${context.query}` : '?';
      default:
        return undefined; // composant dérivé non supporté
    }
  }

  // Statut de dépôt PawaPay → vocabulaire normalisé du contrat PaymentProvider.
  // COMPLETED = payé ; FAILED = refusé ; tout le reste (PROCESSING, statut inconnu)
  // = en cours → PENDING (on ne tranche jamais à tort).
  private mapDepositStatus(status?: string): CheckStatusResult['status'] {
    if (status === 'COMPLETED') return 'APPROVED';
    if (status === 'FAILED') return 'DECLINED';
    return 'PENDING';
  }

  // Montant → string (schéma PawaPay). CDF : entier (certains opérateurs refusent
  // les décimales) ; sinon jusqu'à 2 décimales, sans zéros superflus.
  private formatAmount(amount: number, currency: ProviderCurrency): string {
    if (currency === 'CDF') return String(Math.round(amount));
    return String(Number(amount.toFixed(2)));
  }

  // customerMessage PawaPay : 4–22 caractères alphanumériques + espaces. On
  // nettoie ; si le résultat ne respecte pas la contrainte, on l'omet (optionnel).
  private sanitizeMessage(msg?: string): string | undefined {
    if (!msg) return undefined;
    const clean = msg
      .replace(/[^a-zA-Z0-9 ]/g, '')
      .trim()
      .slice(0, 22);
    return clean.length >= 4 ? clean : undefined;
  }

  private async log(
    paymentRef: string,
    direction: string,
    requestBody: unknown,
    responseBody: unknown,
    status?: string,
  ): Promise<void> {
    try {
      await this.prisma.paymentProviderLog.create({
        data: {
          paymentRef,
          direction,
          requestBody: requestBody ?? Prisma.JsonNull,
          responseBody: responseBody ?? Prisma.JsonNull,
          status,
        },
      });
    } catch (err) {
      this.logger.warn(`PaymentProviderLog non écrit: ${String(err)}`);
    }
  }
}
