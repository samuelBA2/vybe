# Assets billet à la volée (zéro stockage par billet) — Design

**Date :** 2026-08-28
**Branche :** `feat/agent-creation-login-scanTicket`
**Statut :** design validé, prêt pour plan d'implémentation
**Portée :** backend (`~/vybe`) + frontend (`~/vybeFrontend`)

## Contexte (état actuel, confirmé par audit)

- Un billet stocke un `qrToken` (UUID v4, `@unique`, `prisma/schema.prisma:245`). Token opaque, jamais exposé brut dans `/me/tickets` (`src/orders/dto/MyTickets.dto.ts:3`).
- À l'achat, `generateAssetsForOrder` (post-commit best-effort, `src/orders/Order.service.ts:86-92`) génère **par billet** : un QR (`QRCode.toBuffer`, `src/ticket-asset/ticket-asset.service.ts:141`), un PNG composé (sharp), un PDF ; uploade les deux sur Cloudinary et persiste les `secure_url` dans `Ticket.ticketImageUrl` / `Ticket.pdfUrl` (`ticket-asset.service.ts:90-96`).
- **Problème** : génération eager + stockage Cloudinary **par billet** → O(billets). Incompatible avec la billetterie illimitée, et coûteux même à échelle finie (la plupart des billets ne sont jamais téléchargés).
- `TicketCategory.ticketDesignUrl` = image de design uploadée par l'organisateur à la création (1 par catégorie). Service Cloudinary : `src/cloudinary/cloudinary.service.ts`.

## Décision cible

**Un billet = un token en base + un template front + un QR calculé à la volée. Rien n'est stocké par billet, nulle part.**

### 1. Affichage in-app (cas majoritaire) → 100 % client-side

- Le front assemble le billet en HTML/CSS : template de design + infos billet + **QR rendu côté client** à partir du token (lib de **génération** QR front — `jsqr` existant est décode-only, il faut une lib de génération type `qrcode`/`react-qr-code`).
- Le fond design vient de `ticketDesignUrl` (Cloudinary CDN), servi **transformé** : largeur adaptée à l'écran + `f_auto` + `q_auto` dans l'URL (marché RDC = mobile lent/data coûteuse).
- QR et fond = **deux couches CSS séparées**, jamais fusionnées côté serveur pour l'affichage.

### 2. Téléchargement PDF/PNG → génération serveur à la demande, streamée, NON stockée

- À chaque clic download : le serveur compose le billet brandé complet (sharp + design pleine résolution + QR), le **streame** dans la réponse HTTP, puis le jette. Aucun upload Cloudinary.
- Le fichier n'existe comme image que dans les téléchargements de l'appareil du client.
- Rendu strictement identique au design actuel (mêmes helpers `buildTicketImage` / `buildTicketPdf`). Aucune régression visuelle.

### 3. Endpoint token propriétaire

- `GET /me/tickets/:id/qr-token` : renvoie `{ qrToken }` **uniquement** au propriétaire authentifié.
- Jamais dans une liste ; la règle « jamais le qrToken brut » de `/me/tickets` reste. Seul cet endpoint unitaire, gardé par ownership, expose le token.

### 4. Ce qui reste sur Cloudinary (inchangé)

- Uniquement `ticketDesignUrl` : 1 image par catégorie, partagée par tous les billets → O(événements). Bon usage, aucun changement.

### 5. À supprimer / neutraliser

- Génération eager + upload Cloudinary par billet (`generateAssetsForOrder`, `generateForTickets`, `regenerateMissingForUser`).
- Colonnes `Ticket.ticketImageUrl` / `Ticket.pdfUrl` → droppées (voir points tranchés).

## Points ouverts — tranchés

- **(P1) Sort des colonnes + assets Cloudinary existants → (a) drop colonnes + purge one-shot du dossier `TICKETS`.** Cohérent avec « rien par billet ». La purge (Cloudinary Admin API `delete_resources_by_prefix` sur le préfixe du dossier `TICKETS`) est **indépendante des colonnes**, donc l'ordre drop/purge n'a pas de dépendance de lecture.
- **(P2) Offline à l'entrée (côté participant) → OUI.** Le token est **préchargé et caché localement**, le QR se rend hors ligne ; le fond design dégrade vers un **fond neutre brandé** si Cloudinary est injoignable. Le QR seul suffit au scan.
  - Précision d'audit : l'offline concerne **l'affichage côté participant**. La **validation** (`POST /agents/scan`, `agent.service.ts:93`) est serveur → l'agent a toujours besoin de réseau. L'offline de validation (file de scans) est **hors périmètre**.
- **(P3) Cache download → OUI, léger.** `Cache-Control: private, max-age` court + `ETag` sur la réponse streamée, pour éviter de recomposer au re-clic dans une même session. Rien stocké serveur.
- **(P4) Fallback si `ticketDesignUrl` échoue → fond neutre brandé.** Le billet reste lisible et scannable (QR + infos), à l'affichage **et** au download.

## Raffinements actés

- **(R1) Préchargement proactif du token.** Au chargement de la **liste des billets** (réseau présent), **précharger + cacher les tokens des billets À VENIR** (pas seulement à l'ouverture d'un billet). Sinon l'offline (P2) n'est pas garanti. Seuls les billets à venir sont préchargés (les passés n'ont pas besoin d'offline). Implémentation : N requêtes unitaires `:id/qr-token` avec **limite de parallélisme**. Si le volume grossit un jour, un endpoint batch pourra s'ajouter sans casser le contrat unitaire.
- **(R2) Ownership en une requête jointe, 404 (pas 403).** Les endpoints `qr-token` et `download` résolvent l'ownership en **une seule requête** remontant `Ticket → Order.userId` :
  `prisma.ticket.findFirst({ where: { id, order: { userId: req.user.sub } }, select: {...} })`.
  Résultat `null` → `NotFoundException` (**404**), **jamais 403** : un 403 confirmerait l'existence du billet ; un 404 ne divulgue rien. Impératif pour un endpoint qui expose un token.
- **(R3) Grep pré-requis migration.** Avant la migration/le retrait DTO, revérifier qu'aucun lecteur oublié ne lit `ticketImageUrl`/`pdfUrl`. Inventaire ci-dessous (fait le 2026-08-28) à re-confirmer juste avant la migration.

## Inventaire des consommateurs de `ticketImageUrl` / `pdfUrl` (hors specs)

| Fichier | Usage actuel | Action |
|---|---|---|
| `ticket-asset/ticket-asset.service.ts:95` (écrit), `:112` (lit null) | eager gen + regenerate | **supprimé** (gén. eager + `regenerateMissingForUser` retirés) |
| `ticket-asset/tickets.cleanup.ts:22,31-36` | lit pour purger Cloudinary | **retirer la partie Cloudinary** → purge de lignes expirées seule |
| `orders/MyTickets.service.ts:27` (`some(null)`), `:70-71` (select), `:127-128` (map DTO) | déclenche regenerate + expose au DTO | **retirer** ; ajouter `ticketDesignUrl` au select+map |
| `orders/Order.service.ts:97` | select dans le retour d'achat | **retirer** `pdfUrl`/`ticketImageUrl` du select |
| `orders/dto/MyTickets.dto.ts:8-9` | champs DTO | **retirer** ; ajouter `ticketDesignUrl` |
| `prisma/schema.prisma:252-253` | colonnes | **drop** (migration) |

Non impactés (vérifiés) :
- **Scanner agent** (`src/agent/agent.service.ts` scan) : lit `qrToken`/`qrStatus`, jamais ces colonnes.
- **Mail** (`src/mail/mail.service.ts`) : n'envoie pas le billet PNG/PDF ; utilise `ticketDesignUrl` (design catégorie) pour l'e-mail de modération.

Les fichiers `*.spec.ts` correspondants (tickets.cleanup.spec, ticket-asset.service.spec, MyTickets.service.spec, Order.service.spec) devront être mis à jour en conséquence.

## Design backend (`~/vybe`)

1. **Retrait de la génération eager**
   - `Order.service.ts:86-92` : retirer l'appel `generateAssetsForOrder`. L'achat ne génère/uploade plus rien ; retirer aussi `pdfUrl`/`ticketImageUrl` du select de retour (`:97`).
   - `ticket-asset.service.ts` : supprimer `generateAssetsForOrder`, `generateForTickets`, `regenerateMissingForUser` et les appels `uploadBuffer`/`uploadRawBuffer`. **Conserver** `buildTicketImage` et `buildTicketPdf` (réutilisés pour le download).
2. **Nouveaux endpoints** sur `MyTicketsController` (`/me`, `JwtAuthGuard` + `RolesGuard('USER')`, ownership R2) :
   - `GET /me/tickets/:id/qr-token` → `{ qrToken }` (findFirst joint ; 404 si non-propriétaire).
   - `GET /me/tickets/:id/download?format=png|pdf` → compose (design pleine réso + QR) et **streame** (`Content-Type`, `Content-Disposition: attachment`), sans Cloudinary ; headers `Cache-Control: private, max-age` + `ETag` (P3). Ownership R2. Fallback design P4.
3. **DTO liste** : `MyTickets.dto.ts` — retirer `ticketImageUrl`/`pdfUrl`, **ajouter `ticketDesignUrl`** (depuis la catégorie) ; `MyTickets.service.ts` adapte select + map, et **retire** la logique `some(null)` / appel regenerate.
4. **Migration Prisma** : drop `Ticket.ticketImageUrl` et `Ticket.pdfUrl`. Pré-requis : R3 (inventaire re-vérifié).
5. **Nettoyage**
   - **Purge one-shot** du dossier Cloudinary `TICKETS` (Admin API `delete_resources_by_prefix`) — commande/script admin, exécuté une fois.
   - `tickets.cleanup.ts` : retirer la partie Cloudinary → purge de **lignes** expirées seule (garder `ticket.delete`).

## Design frontend (`~/vybeFrontend`)

6. **Rendu billet client-side** (HTML/CSS) : fond = `ticketDesignUrl` via URL Cloudinary transformée (`f_auto,q_auto,w_<largeur écran>`) + couche **QR généré côté client** (lib de génération à ajouter) + overlay infos. QR et fond = 2 couches CSS séparées.
7. **Token** : hook/service qui appelle `GET /me/tickets/:id/qr-token`, **caché localement de façon persistante**. **Préchargement proactif** (R1) des tokens des billets à venir au chargement de la liste, tant qu'il y a du réseau, avec limite de parallélisme.
8. **Offline** (P2) : hors réseau → QR rendu depuis le token caché + **fond fallback neutre brandé** si le design Cloudinary est injoignable.
9. **Download** : boutons PNG/PDF → l'endpoint streamé (`GET /me/tickets/:id/download`), fichier jamais stocké.
10. **Fallback design** (P4) : `ticketDesignUrl` en échec (affichage ou download) → fond neutre, billet lisible + scannable.

Le frontend actuel (qui affiche le PNG serveur et télécharge via URL Cloudinary) est remplacé par ce rendu client-side + download serveur.

## Hors périmètre

- **Webhook CinetPay & émission de billets** (specs séparées). Couplage noté : comme on ne génère plus d'assets eager, le futur worker webhook **ne génère et n'uploade aucun asset** → simplifie sa spec.
- Index `Order`, pagination keyset, sémantique « restants » du dashboard, revenus : chantiers parallèles.

## Tests (intentions)

- Backend : endpoints `qr-token` (404 pour non-propriétaire via requête jointe ; token pour propriétaire) et `download` (streame le bon Content-Type, jamais d'appel Cloudinary upload, headers cache) ; `Order.createOrder` ne génère plus d'assets ; `tickets.cleanup` ne touche plus Cloudinary ; `MyTickets` renvoie `ticketDesignUrl` et plus les colonnes droppées. Mise à jour des specs listés.
- Frontend : rendu billet (QR + fond) ; préchargement/cache token ; fallback offline (token caché, fond neutre) ; fallback design ; download déclenche l'endpoint serveur.

## Décision différée (à confirmer à l'implémentation)

- Forme exacte du download : une route `?format=png|pdf` vs deux routes `/download.png` et `/download.pdf`. Sans incidence sur le design ; à trancher dans le plan.
