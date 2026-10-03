# Procédure de mise en production — Vybe

> Rédigé le 2026-10-01 à partir du code de `feat/araka-provider` (back) et `front-araka-provider` (front).
> **Avertissement juridique** : la partie 2 a été rédigée par un assistant, pas par un avocat. Les références légales sont marquées `[à vérifier]` quand elles ne viennent pas d'une source officielle. **Faites tout valider par un juriste RDC et un juriste FR/UE avant d'ouvrir.**

Ordre de lecture : **1. Bug de déconnexion au refresh** (à corriger d'abord, car il affecte la recette) → **2. Conformité juridique** → **3. Services et coûts** → **4. Runbook de mise en prod (J-30 → J+30)**.

---

## 1. Bug : un rafraîchissement de page déconnecte l'utilisateur

### Ce que fait le code aujourd'hui (et qui est correct)
- Back : `signToken` émet un access token de 30 min et un refresh token de 30 jours (`src/auth/auth.service.ts:51-68`). Le refresh est posé dans un cookie httpOnly `vybe_refresh` limité au chemin `/auth` (`src/auth/auth.controller.ts:25-40`).
- Front : l'access token est gardé **en mémoire** (`vybeFrontend/src/lib/api/client.ts:29`), donc **il disparaît à chaque F5**. Au montage, `AuthContext` appelle `POST /auth/refresh` (`restoreSession`) pour le récupérer à partir du cookie.

**Conclusion : la session survit au F5 si et seulement si le navigateur renvoie le cookie `vybe_refresh` à l'API.** Si la session est perdue au refresh, c'est que le cookie n'est pas envoyé. Trois causes ont été trouvées dans le code ; elles s'additionnent.

### Cause n°1 (la plus probable) : cookie tiers bloqué entre deux domaines
Le front est sur Vercel (`vybeplatform.app`) et l'API sur `*.onrender.com` (`.env.example` du front : `vybe-backend-few9.onrender.com`). Ce sont **deux sites différents**, donc pour le navigateur `vybe_refresh` est un **cookie tiers** :
- **Safari (macOS et iOS, donc tous les navigateurs sur iPhone)** bloque tous les cookies tiers par défaut (ITP) → `POST /auth/refresh` reçoit 401 → l'utilisateur redevient « invité » à chaque F5.
- Brave, Firefox en mode strict, la navigation privée de Chrome, et Chrome quand l'utilisateur a bloqué les cookies tiers : même effet.

Pour Vybe, c'est rédhibitoire : en RDC comme en France, une grande partie du public est sur iPhone.

**Correction recommandée : mettre l'API sur un sous-domaine du site.**
1. Render → service backend → *Custom Domains* → ajouter `api.vybeplatform.app` (ou le domaine final). Chez le registrar, créer un `CNAME api → <service>.onrender.com`. Render fournit le certificat TLS.
2. Front (Vercel) : `VITE_API_URL=https://api.vybeplatform.app`, puis redéployer (la variable est intégrée au build).
3. Back : `FRONTEND_URLS=https://vybeplatform.app,https://www.vybeplatform.app`.
4. Le cookie devient alors un cookie **du même site** (même domaine enregistrable `vybeplatform.app`). Passer en `sameSite: 'lax'` + `secure: true` en prod. `none` n'est plus nécessaire et reste exposé aux blocages.

> Note Safari : quand un sous-domaine pointe en CNAME vers un tiers (Render), Safari peut limiter la durée des cookies posés par ce sous-domaine à environ 7 jours `[à vérifier]`. Le F5 fonctionne quand même ; seul un utilisateur absent plus de 7 jours devra se reconnecter. C'est acceptable.

*Autre option, moins bonne* : un rewrite Vercel `/api/(.*) → https://<backend>.onrender.com/$1`, qui rend l'API « same-origin ». Inconvénients : un saut réseau de plus et une IP client vue derrière deux proxies (`trust proxy` et le rate limiting à revoir). La solution à retenir est le sous-domaine.

### Cause n°2 : `NODE_ENV` absent sur Render
`setRefreshCookie` choisit `secure`/`sameSite` selon `process.env.NODE_ENV === 'production'` (`auth.controller.ts:31`). Render **ne définit pas** `NODE_ENV` tout seul `[à vérifier dans Render → Environment]`. S'il manque, le cookie part en `SameSite=Lax`, sans `Secure`. En cross-site (situation actuelle), un cookie Lax **n'est jamais envoyé** sur un `fetch` POST, et ce **dans tous les navigateurs**. Résultat : déconnexion à chaque F5, même sous Chrome.
→ **Définir explicitement `NODE_ENV=production`** sur les services Render staging et prod. Pour le savoir, on peut regarder dans l'onglet Réseau du navigateur la réponse de `POST /auth/login` : l'en-tête `Set-Cookie` doit contenir `Secure` et le `SameSite` attendu.

### Cause n°3 : la déconnexion n'efface pas le cookie en prod (bug inverse)
`logout` fait `res.clearCookie(REFRESH_COOKIE, { path: '/auth' })` (`auth.controller.ts:140`), sans `secure` ni `sameSite`. En cross-site, Chrome refuse un `Set-Cookie` sans `SameSite=None; Secure`. Le cookie survit donc, et l'utilisateur « déconnecté » se retrouve reconnecté au F5 suivant.
→ Factoriser les options du cookie et les réutiliser pour l'effacement :
```ts
function refreshCookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return { httpOnly: true, secure: isProd, sameSite: 'lax' as const, path: '/auth' };
}
// set   : res.cookie(REFRESH_COOKIE, token, { ...refreshCookieOptions(), maxAge: REFRESH_MAX_AGE_MS })
// clear : res.clearCookie(REFRESH_COOKIE, refreshCookieOptions())
```

### Points secondaires (non bloquants, à planifier)
- **Pas de révocation des refresh tokens** : un refresh volé reste valable 30 jours, même après une déconnexion ou un changement de mot de passe. Correction : stocker un `jti` par refresh (table `RefreshToken` ou réutilisation de `UsedToken`), le consommer à chaque rotation et tout révoquer au changement de mot de passe ou à la suppression du compte. Attention aux deux onglets qui rafraîchissent en même temps : prévoir une tolérance de quelques secondes sur le `jti` précédent.
- **Agents** : leur token est en `sessionStorage`. Il survit au F5 mais pas à la fermeture de l'onglet. C'est voulu ; à rappeler dans la doc agent.

### Recette du correctif (à faire sur staging, sur un vrai iPhone)
1. Se connecter, F5 → toujours connecté. 2. Fermer et rouvrir Safari → toujours connecté. 3. Se déconnecter, F5 → invité. 4. Même chose sous Chrome en navigation privée. 5. Attendre plus de 30 min (expiration de l'access token), naviguer → refresh silencieux, pas de toast « session expirée ».

---

## 2. Conformité juridique (RDC + France/UE)

### 2.0 Quel droit s'applique ?
| Situation | Droit applicable |
|---|---|
| Événement en RDC, acheteur en RDC | **RDC** : Code du numérique (loi n°23/010 du 13 mars 2023), droit de la consommation congolais `[à vérifier : loi n°18/035 du 13 déc. 2018 relative à la protection du consommateur]`, OHADA, fiscalité RDC |
| Acheteur résidant en France/UE (même pour un événement en RDC) | **FR/UE** pour la protection du consommateur et les données : Code de la consommation, RGPD, DSA. Un professionnel qui « dirige son activité » vers l'UE ne peut pas en priver le consommateur `[à vérifier : règlement Rome I art. 6]` |
| Organisateur établi en France | Code de commerce, DSA (traçabilité des professionnels), TVA FR |

Tant que Vybe ne vise pas activement la France (paiement en euros, langue, publicité), le risque FR/UE reste limité. Mais la page « Confidentialité » et le footer ne doivent pas affirmer « RDC uniquement » si des Français peuvent s'inscrire.

### 2.1 État des lieux (constaté dans le code)
| Élément | État | Problème |
|---|---|---|
| CGU (toute la plateforme) | ❌ inexistantes | Aucune page, aucune case à l'inscription. Rien n'encadre la relation avec l'utilisateur |
| CGV acheteurs (vente de billets) | ❌ inexistantes | `Buy.tsx` : bouton « Commander » sans acceptation de conditions ni information sur la rétractation et le remboursement |
| Conditions organisateurs | ⚠️ case sans document | `CreateEvent.tsx:405` « J'accepte les conditions d'utilisation et la commission » renvoie à un texte qui **n'existe pas**. L'acceptation est stockée en booléen, sans version ni date de référence |
| Politique de confidentialité | ⚠️ publiée, à corriger | `Confidentialite.tsx` cite encore **PawaPay** (fournisseur remplacé par **ARAKA/ProxyPay**). Version RDC seulement. Brouillon `docs/legal/` : 29 `[à compléter]`/`[à vérifier]` |
| Cookies | ✅ page présente | Seulement des traceurs strictement nécessaires (refresh, token agent, brouillons, cache billet) : pas de bandeau de consentement requis. **Ne rien ajouter (analytics, pixel) sans bandeau** |
| Mentions légales | ❌ inexistantes | Obligatoires en France dès le 1er jour `[LCEN art. 6-III]` ; identification du prestataire exigée en RDC `[à vérifier : Code du numérique, commerce électronique]` |
| Tarifs | ✅ `Tarifs.tsx` (20 %) cohérent avec `PLATFORM_FEE_RATE = 0.2` | — |
| Suppression de compte | ✅ soft delete puis anonymisation à J+14, commandes conservées | Cas de l'organisateur avec un **solde dû** : l'anonymiser empêche de le payer. À traiter dans les CGU et dans le code (bloquer la suppression tant que le solde est > 0) |
| Annulation / report d'événement | ❌ aucun flux | Personne n'est désigné pour rembourser, ni selon quelle procédure. Point obligatoire des CGV |
| Fonds de tiers (80 % dus aux organisateurs) | ⚠️ bloquant juridique connu | Encaisser pour le compte de tiers relève d'un régime réglementé (RDC : BCC / établissement de monnaie électronique ; UE : DSP2, établissement de paiement). ARAKA, agréé, réduit le risque côté RDC **sans le supprimer**. **Avis juridique écrit nécessaire avant d'encaisser réellement** |

### 2.2 Documents à produire
Il faut **quatre documents séparés**, chacun versionné et daté, publiés en pages du front et liés depuis le footer :

**A. Conditions générales d'utilisation (CGU)**, pour tous les utilisateurs
- Objet ; Vybe est un **intermédiaire**, l'organisateur est le vendeur du billet (à arbitrer avec le juriste : mandat d'encaissement ou revente).
- Création de compte : âge minimum (FR : 15 ans pour consentir seul au traitement des données `[loi Informatique et Libertés art. 45]` ; 18 ans pour organiser ou encaisser), exactitude des informations, sécurité du compte.
- Comportements interdits, modération, suspension et suppression de compte (en lien avec le flux de soft delete).
- **Signalement de contenus illicites** (UE : DSA art. 16, mécanisme de notification) et **motivation des décisions** (DSA art. 17). L'e-mail de refus d'un événement (`sendEventDecisionEmail`) doit donner le motif et indiquer comment contester.
- Point de contact unique pour les autorités et les utilisateurs (DSA art. 11-12).
- Responsabilité, propriété intellectuelle (visuels uploadés par les organisateurs : licence accordée à Vybe), droit applicable, juridiction, médiation de la consommation (FR : **désignation d'un médiateur obligatoire** `[Code conso L612-1]`).

**B. Conditions générales de vente (CGV) billetterie**, pour les acheteurs
- Identité du vendeur (l'organisateur) et rôle de Vybe ; **prix TTC** et frais (FR : information des plateformes sur la qualité du vendeur, pro ou particulier `[Code conso L111-7]`).
- Paiement Mobile Money via ARAKA, devise (CDF/USD par événement), taux de conversion.
- Remise du billet (QR à usage unique, PNG/PDF), contrôle à l'entrée, règle anti-revente (FR : revente habituelle sans autorisation de l'organisateur interdite `[Code pénal art. 313-6-2]`).
- **Pas de droit de rétractation** pour un loisir à date déterminée (FR `[Code conso L221-28 12°]`). Il faut **l'annoncer avant le paiement**, faute de quoi le délai de 14 jours s'applique. RDC : vérifier l'existence d'un droit de rétractation pour la vente à distance `[à vérifier : Code du numérique]`.
- **Annulation ou report** : qui rembourse (l'organisateur), dans quel délai, par quel canal, et ce que devient la commission de 20 %.
- Réclamations, médiation, droit applicable.

**C. Conditions organisateurs** (contrat de services, en B2B)
- Commission de 20 %, assiette (HT/TTC), facturation de la commission par Vybe.
- Versements : maturation `PAYOUT_MATURATION_DAYS` (4 j), minimum et maximum, canal Mobile Money, frais opérateur.
- Obligations de l'organisateur : autorisations administratives, sécurité, assurance, exactitude des informations, **remboursement en cas d'annulation**, ses propres obligations fiscales (TVA sur la billetterie).
- **KYC / traçabilité** : identité, coordonnées, RCCM/NIF (RDC), SIREN (FR). UE : DSA art. 30, dont les micro et petites entreprises sont dispensées `[DSA art. 29]`, mais la vérification reste un minimum pour encaisser des fonds `[à vérifier]`.
- Modération (PENDING_REVIEW → PUBLISHED/REJECTED), droit de retrait d'un événement, compensation et retenue en cas de litige.
- Organisateur avec un solde dû qui supprime son compte : règle explicite.

**D. Politique de confidentialité** : partir du brouillon `docs/legal/politique-de-confidentialite.md`
- Remplacer **PawaPay → ARAKA (ProxyPay)** dans `Confidentialite.tsx` et dans le brouillon.
- Sous-traitants et lieu des données : Render (Francfort), Neon (région à confirmer), Vercel, Twilio et SendGrid (États-Unis : transfert hors UE, couvert par le Data Privacy Framework ou des clauses contractuelles types `[à vérifier]`), Cloudinary, ARAKA.
- Durées de conservation **alignées sur le code** : OTP, `UsedToken`, `CheckoutRequest` 24 h, anonymisation à J+14, billets expirés (cron), **pièces comptables 10 ans** (FR `[Code de commerce L123-22]`, OHADA `[Acte uniforme comptable]`). L'anonymisation garde les commandes, ce qui est cohérent.
- Droits des personnes et canal d'exercice (e-mail dédié) ; FR : réclamation auprès de la CNIL ; RDC : autorité de protection des données prévue par le Code du numérique `[à vérifier : nom et formalités de déclaration préalable]`.
- FR : **registre des traitements** (document interne). Un DPO n'est a priori pas obligatoire.

**E. Mentions légales** : dénomination, forme, capital, siège, RCCM / Id. Nat. / NIF (RDC) ou SIREN / TVA intracom (FR), directeur de publication, contact (+243 972 805 729, `/contact`), hébergeurs avec adresse (Render, Vercel, Neon, Cloudinary).

### 2.3 Changements de code liés à la conformité
| # | Changement | Où |
|---|---|---|
| L1 | Pages `/cgu`, `/cgv`, `/conditions-organisateurs`, `/mentions-legales` + liens dans le footer | front `App.tsx`, `pages/` |
| L2 | **Preuve d'acceptation** : `User.termsVersion` + `termsAcceptedAt` (inscription), `Order.cgvVersion` (achat), `Event.organizerTermsVersion` + date (création). Le booléen seul ne prouve rien | Prisma + `complete-profile`, `POST /order`, `POST /events` |
| L3 | Case « J'accepte les CGU » **non pré-cochée** à l'inscription | `Auth.tsx` + DTO `CompleteProfileDto` |
| L4 | Page d'achat : récapitulatif TTC, mention « pas de droit de rétractation », lien CGV, case d'acceptation, bouton **« Commander avec obligation de paiement »** (FR `[Code conso L221-14]` : « Commander » seul ne suffit pas) | `Buy.tsx` |
| L5 | Lien de la case organisateur vers le vrai document + version stockée | `CreateEvent.tsx:405` |
| L6 | Formulaire « Signaler cet événement » (DSA art. 16) + motif dans l'e-mail de refus | `EventDetails`, `MailService.sendEventDecisionEmail` |
| L7 | Bloquer la suppression de compte si le solde organisateur est > 0 ou si un payout est en cours | `UsersService.requestAccountDeletion` |
| L8 | `Confidentialite.tsx` : PawaPay → ARAKA, liste des sous-traitants à jour | front |
| L9 | Procédure d'annulation d'événement (au minimum manuelle et documentée en V1) | ops + CGV |

### 2.4 Fiscalité et administratif (avant la première vente réelle)
- **RDC** : immatriculation RCCM, Id. Nat., NIF ; **TVA 16 %** sur la commission de Vybe `[à vérifier : assujettissement et seuil]` ; facturation de la commission aux organisateurs.
- **FR** (si une entité y est créée) : SIREN, TVA 20 % sur la commission (service électronique), et TVA du lieu de consommation pour les clients UE (guichet OSS) `[à vérifier]`.
- Contrat ARAKA/ProxyPay signé, avec URL de prod, clé de callback et utilisateur API dédié.
- Accessibilité (UE, European Accessibility Act depuis juin 2025) : les microentreprises fournissant des services en sont exemptées `[à vérifier]`.
- AI Act : non concerné (Vybe n'a aucune fonctionnalité d'IA).

---

## 3. Services à payer

Tarifs publics relevés le 2026-10-01 (en USD, hors taxes). **À revérifier au moment de souscrire.**

| Service | Rôle | Gratuit possible en prod ? | Offre recommandée | Coût/mois |
|---|---|---|---|---|
| **Render** (backend) | API NestJS + crons | ❌ (le Free s'endort après 15 min : callbacks paiement manqués, crons arrêtés) | **Starter 7 $** (0,5 CPU / 512 Mo) au départ. **Standard 25 $** (2 Go) dès que la génération PNG/PDF des billets (sharp + pdfkit) sature la mémoire | 7 → 25 $ |
| Render (workspace) | équipe | Hobby gratuit suffit au départ | Pro 25 $/workspace seulement pour les fonctions d'équipe | 0 $ |
| **Neon** (Postgres) | base de données | ❌ (Free : 0,5 Go, restauration 6 h, suspension si quota dépassé) | **Launch** à l'usage : 0,106 $/CU-h, 0,35 $/Go-mois, restauration jusqu'à 7 j. Les crons toutes les 10 min empêchent la mise en veille, donc environ 0,25 CU × 730 h | ≈ 20 $ |
| Neon (staging) | base dédiée | branche ou projet séparé | +1,50 $/branche-mois | ≈ 2-5 $ |
| **Vercel** (front) | SPA React | ❌ **le plan Hobby interdit l'usage commercial** | **Pro** | 20 $ |
| **SendGrid** (e-mails) | OTP, modération, notifications | ❌ plus d'offre gratuite permanente (essai de 60 j, 100 e-mails/j) | **Essentials** jusqu'à 50 000 e-mails | 19,95 $ |
| **Twilio** (SMS) | OTP par téléphone | — | Paiement à l'usage : **0,2584 $/SMS vers la RDC**, sender ID alphanumérique gratuit | **variable : 1 000 SMS ≈ 258 $** |
| **Cloudinary** | visuels événements, avatars | ✅ Free (25 crédits) au lancement | Plus 89-99 $ si dépassement | 0 $ |
| **ARAKA / ProxyPay** | Mobile Money | — | commission par transaction, **à négocier au contrat** | variable |
| Nom de domaine | `vybeplatform.app` (+ `.cd` ?) | — | renouvellement annuel | ≈ 1-5 $ |
| Supervision (conseillé) | erreurs + disponibilité | Sentry Developer et Better Stack ont des offres gratuites | gratuit | 0 $ |

**Coûts fixes : environ 70 $/mois au lancement** (Render 7 + Neon ≈20 + Vercel 20 + SendGrid 20 + domaine), **environ 90 $** avec Render Standard. Il faut y ajouter les **SMS**, premier poste variable et le plus risqué : à 0,26 $ le SMS, un OTP par téléphone coûte environ 160 FC.
→ Recommandations : privilégier l'e-mail ou le mot de passe pour la connexion et réserver le SMS à l'inscription ; garder les throttles actuels (3/min) ; mettre une **alerte de dépense Twilio** ; comparer avec un agrégateur SMS local RDC ou WhatsApp OTP `[à étudier]`.

Paramétrer des **alertes de facturation** sur Neon (spending notifications), Twilio (usage triggers) et Render.

---

## 4. Runbook de mise en production

### Phase A — Décisions et prérequis externes (J-30 → J-15)
- [ ] Entité juridique et immatriculations (2.4), **avis juridique sur l'encaissement pour compte de tiers**.
- [ ] Documents A à E rédigés puis validés par les juristes RDC et FR.
- [ ] Domaine final choisi et DNS accessible.
- [ ] Contrat ARAKA de prod : `ARAKA_BASE_URL` prod, identifiants dédiés, `ARAKA_PAYMENT_PAGE_ID`, `ARAKA_CALLBACK_KEY`, préfixes opérateurs confirmés.
- [ ] Comptes payants ouverts (section 3) et alertes de facturation actives.

### Phase B — Bloquants de code (J-15 → J-7) — sur des branches de feature
- [ ] **Session** : sous-domaine API, cookie `lax`/`secure`, effacement du cookie corrigé, `NODE_ENV=production` (section 1).
- [ ] **Scan antivirus des PDF** sur `POST /uploads` (TODO de CLAUDE.md, choix ClamAV / heuristique / API). Autre option : retirer temporairement `application/pdf` de `ALLOWED_MIME` pour ne pas bloquer le lancement.
- [ ] Changements de conformité L1 à L9 (section 2.3), migrations Prisma comprises.
- [ ] Merges dans l'ordre : back `feat/payments` → `main`, puis `feat/araka-provider` → `main` ; front `feat/event-details-tablet-responsive` → `main`, puis `front-araka-provider` → `main`. **Back et front partent ensemble** (contrats `/events` paginé et `POST /order` sans `currency`).
- [ ] Suites vertes : `npm test` (back) et `npm test` + `npm run build` (front). Lint avec `npx eslint` **sans** `--fix`.

### Phase C — Infrastructure de prod (J-7)
- [ ] **Neon** : **projet de prod séparé** (pas une branche de la base de dev partagée). Région UE (Francfort) proche de Render. Garder `DATABASE_URL` (pooler) et `DIRECT_DATABASE_URL` (direct, pour les migrations). Activer la restauration à un instant donné (PITR) sur 7 j.
- [ ] **Render** : nouveau service prod (le staging reste en place), région Frankfurt.
  - Build : `npm install && npx prisma generate && npm run build`
  - Pre-Deploy : `npx prisma migrate deploy` (**jamais** `migrate dev`)
  - Start : `npm run start:prod` (= `node dist/src/main`)
  - Health check path : `/`
  - **Une seule instance** : les crons `@nestjs/schedule` (reaper paiement, payouts, purges) tournent dans le process. Avec 2 instances, ils s'exécuteraient deux fois. Avant de passer à plusieurs instances, ajouter un verrou (advisory lock Postgres).
- [ ] **Domaines** : `vybeplatform.app` → Vercel ; `api.vybeplatform.app` → Render.
- [ ] **SendGrid** : *Domain Authentication* (enregistrements DKIM + SPF), DMARC `p=none` puis `quarantine`, expéditeur `no-reply@vybeplatform.app`. Sans cela, les OTP partent en spam.
- [ ] **Twilio** : sender ID alphanumérique `VYBE` pour la RDC `[à vérifier : pré-enregistrement requis ?]`, compte passé hors mode essai.
- [ ] **Cloudinary** : décider entre un cloud dédié à la prod et le cloud de dev (recommandé : dédié).
- [ ] **Variables d'environnement** (back, Render) :

| Variable | Valeur prod |
|---|---|
| `NODE_ENV` | `production` ← **nouveau, obligatoire** |
| `DATABASE_URL` / `DIRECT_DATABASE_URL` | Neon prod (poolé / direct) |
| `JWT_SECRET` | **nouveau secret**, 64 octets aléatoires, différent du staging |
| `API_BASE_URL` | `https://api.vybeplatform.app` |
| `FRONTEND_URLS` | `https://vybeplatform.app,https://www.vybeplatform.app` |
| `VYBE_TEAM_EMAIL` | adresse de modération |
| `APP_TIMEZONE` | `Africa/Kinshasa` |
| `SENDGRID_API_KEY` / `SENDGRID_FROM_EMAIL` / `SENDGRID_FROM_NAME` | clé prod restreinte à *Mail Send* |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER` | prod |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | prod |
| `ARAKA_BASE_URL` / `ARAKA_EMAIL` / `ARAKA_PASSWORD` / `ARAKA_PAYMENT_PAGE_ID` / `ARAKA_CALLBACK_KEY` | prod (`https` obligatoire) |
| `ARAKA_DISABLED_OPERATORS` | vide |
| `USD_TO_CDF_RATE`, `PAYMENT_PENDING_TTL_MINUTES`, `PAYOUT_MATURATION_DAYS`, `PAYOUT_MIN_AMOUNT`, `PAYOUT_MAX_AMOUNT`, `PAYOUT_STUCK_TTL_MINUTES` | valeurs métier validées |
| `PORT` | **ne pas définir** (Render l'injecte) |

  Front (Vercel, *Production*) : `VITE_API_URL=https://api.vybeplatform.app`, `VITE_SITE_URL=https://vybeplatform.app`.
- [ ] Callback ARAKA de prod : `https://api.vybeplatform.app/payments/webhook`. Test de joignabilité : `POST` avec un corps vide → 400 attendu.

### Phase D — Répétition générale sur staging (J-5)
Le staging doit avoir la même configuration que la prod (sous-domaine `api-staging.…`, `NODE_ENV=production`, ARAKA UAT). C'est la Task 13 du plan ARAKA.
- [ ] Inscription e-mail **et** téléphone, puis F5 et réouverture du navigateur (recette de la section 1, sur iPhone).
- [ ] Création d'un événement → e-mail de modération → approbation → publication.
- [ ] Achat réel UAT (Airtel / Orange / M-Pesa) → webhook signé → billets émis → téléchargement PNG/PDF.
- [ ] Échec de paiement et expiration par le reaper (`PENDING` → expiré après `PAYMENT_PENDING_TTL_MINUTES`).
- [ ] Agent : connexion par code, scan valide, rescan → 409.
- [ ] Payout organisateur après maturation.
- [ ] Suppression de compte puis anonymisation (avancer `deletionRequestedAt` en base de staging).
- [ ] Pages légales accessibles depuis le footer ; preuves d'acceptation stockées en base.

### Phase E — Jour J (créneau creux)
1. Geler les merges. Taguer `main` back et front : `v1.0.0`.
2. Sauvegarde : Neon prod, branche `pre-v1` (instantané).
3. Déployer le **back** (le Pre-Deploy applique les migrations), puis vérifier les logs : migrations OK, `Nest application successfully started`.
4. Déployer le **front** (Vercel).
5. Si le cloud Cloudinary prod contient d'anciens assets de billets : `node -r ts-node/register -r dotenv/config scripts/purge-ticket-assets.ts` (**irréversible**, après le déploiement du code uniquement).
6. Tests de fumée en prod : `GET /` → 200 ; inscription réelle ; F5 ; achat d'un billet à petit prix ; scan ; webhook bien reçu (logs Render).
7. Activer la supervision : Sentry (back + front) et une sonde de disponibilité sur `/`.

**Retour arrière** : Render → *Rollback* vers le déploiement précédent ; Vercel → *Promote* du build précédent. Les migrations Prisma ne s'annulent pas automatiquement : en cas de migration destructrice, restaurer la branche Neon `pre-v1`. **Règle à adopter : uniquement des migrations additives le jour J.**

### Phase F — Après le lancement (J+1 → J+30)
- [ ] Surveiller chaque jour les erreurs Sentry, les `PENDING` expirés, la consommation Twilio et la mémoire Render (passer en Standard si elle dépasse 80 %).
- [ ] Vérifier les factures de fin de mois par rapport à l'estimation de la section 3.
- [ ] Révocation des refresh tokens (section 1, points secondaires).
- [ ] Endpoint de récupération de compte pendant les 14 jours de grâce (encore absent).
- [ ] Revue juridique trimestrielle : tenir à jour la liste des sous-traitants dans la politique de confidentialité à chaque nouveau fournisseur.
