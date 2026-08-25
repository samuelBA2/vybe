# Brique C — `GET /me/tickets` (liste des billets de l'utilisateur)

**Date :** 2026-08-18
**Statut :** Design validé, prêt pour plan d'implémentation

## Objectif

Permettre à un utilisateur authentifié de consulter ses propres billets via
`GET /me/tickets`. La réponse est **groupée par événement** et **séparée en deux
groupes** : `upcoming` (événements à venir) et `past` (événements passés).

C'est un endpoint de **lecture seule**. Aucune logique d'achat, de scan ou
d'annulation n'est modifiée ici.

## Portée

Inclus :
- Nouveau champ schéma `Ticket.cancelledAt` (migration Prisma).
- Nouveau contrôleur `MyTicketsController` (`GET /me/tickets`).
- Nouveau service `MyTicketsService.getMyTickets(userId)`.
- Test unitaire du service.

Hors périmètre (briques futures) :
- La logique d'annulation qui *pose* `cancelledAt` (remboursement / annulation).
- Le scan par les agents.
- La pagination.

## Modèle de données

### Migration : `Ticket.cancelledAt`

Ajout d'un champ optionnel horodatant le passage d'un billet en `CANCELLED` :

```prisma
model Ticket {
  // ... champs existants ...
  cancelledAt DateTime?  // posé au moment de l'annulation (brique future)
}
```

Justification : le modèle actuel n'a aucun horodatage d'annulation
(`scannedAt` concerne le scan). Sans ce champ, la règle « les billets annulés
restent visibles 24h puis disparaissent » est inimplémentable. Le champ est
ajouté maintenant ; il n'est *écrit* par aucun code de cette brique — seulement
*lu*.

## Route & autorisation

- Nouveau contrôleur `MyTicketsController` :
  `@Controller('me')` + `@Get('tickets')` → route publique `/me/tickets`.
- Placé dans le `OrderModule` existant (pas de nouveau module pour un seul
  endpoint ; un `TicketsModule` dédié pourra être extrait plus tard quand les
  briques scan/annulation arriveront).
- Gardes identiques au contrôleur d'achat :
  `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles('USER')`.
- Identité : `userId = req.user.sub`.

Note : tous les utilisateurs créés portent le rôle `USER` (le rôle `ADMIN` est
distinct et réservé à d'autres usages). `@Roles('USER')` est donc correct.

## Service — `MyTicketsService.getMyTickets(userId)`

Service dédié (`PrismaService` injecté), séparé d'`OrderService` : la lecture
côté acheteur est isolée de l'écriture (création de commande). Enregistré dans
le `OrderModule`.

### Chargement

Charger les billets dont la commande appartient à l'utilisateur, avec les
relations nécessaires :

- `Ticket` → `order` (pour filtrer sur `order.userId === userId`)
- `Ticket` → `ticketCategory` (pour `name` = `categoryName`)
- `ticketCategory` → `event` (infos événement)
- `event` → `mediaFiles` filtrés `isPoster: true` (pour `posterUrl`)

### Filtre des billets annulés (règle des 24h)

Soit `cutoff = now − 24h`. Un billet est **conservé** si :

```
qrStatus !== 'CANCELLED'
  OU (cancelledAt != null ET cancelledAt >= cutoff)
```

Conséquences :
- Billet non annulé → toujours visible.
- Billet annulé il y a moins de 24h → visible (le front peut le griser).
- Billet annulé il y a plus de 24h → masqué.
- Billet `CANCELLED` sans `cancelledAt` (données incohérentes) → masqué.

### Un billet = une entrée (achats multiples)

Chaque unité achetée est une ligne `Ticket` distincte (le `createOrder` fait un
`createMany` de `quantity` billets, chacun avec son propre `qrToken`, `pdfUrl` et
`ticketImageUrl`). Conséquences côté réponse :

- Une commande de N billets → **N entrées** dans le tableau `tickets` de
  l'événement, chacune avec son propre QR/PNG/PDF.
- Plusieurs commandes du **même** utilisateur pour le **même** événement →
  **fusionnées** sous une seule entrée d'événement ; tous leurs billets sont
  réunis dans le même tableau `tickets`. (Une carte par événement, tous les QR
  dedans.)

Chaque billet porte à la fois `ticketImageUrl` (PNG) et `pdfUrl` (PDF) : le front
affiche le PNG et propose un bouton « télécharger » vers le PNG **ou** le PDF.

### Regroupement & split

1. Grouper les billets conservés par `event.id`.
2. Pour chaque événement : `endDate >= now` → groupe `upcoming`, sinon `past`.
3. Tri :
   - `upcoming` : par `startDate` croissante (le plus proche en premier).
   - `past` : par `startDate` décroissante (le plus récent en premier).

## Forme de la réponse

```jsonc
{
  "upcoming": [
    {
      "event": {
        "id": "…",
        "reference": "VYBE-67XC6F",
        "title": "…",
        "startDate": "2026-09-01T20:00:00.000Z",
        "endDate": "2026-09-02T02:00:00.000Z",
        "location": "…",
        "posterUrl": "https://res.cloudinary.com/…"  // null si pas d'affiche
      },
      "tickets": [
        {
          "id": "…",
          "categoryName": "VIP",
          "qrStatus": "UNUSED",
          "ticketImageUrl": "https://res.cloudinary.com/…", // null si génération échouée
          "pdfUrl": "https://res.cloudinary.com/…",         // null si génération échouée
          "expiresAt": "2026-09-02T02:00:00.000Z",
          "cancelledAt": null
        }
      ]
    }
  ],
  "past": [ /* même forme */ ]
}
```

Le `qrToken` brut **n'est jamais exposé** : le QR est déjà intégré dans le PNG
(`ticketImageUrl`) produit par la brique D. Exposition minimale du secret.

## Gestion des cas limites

- **Aucun billet** → `{ "upcoming": [], "past": [] }`.
- **Poster absent** → `event.posterUrl = null`.
- **Visuels non générés** (génération best-effort échouée en brique D) →
  `ticketImageUrl` / `pdfUrl` à `null`, le billet reste listé.

## Tests

Spec unitaire (`MyTicketsService`, `PrismaService` mocké) couvrant :

- Regroupement de plusieurs billets d'un même événement en une seule entrée.
- Split `upcoming` vs `past` selon `endDate` vs `now`.
- Tri `upcoming` croissant / `past` décroissant.
- Frontière des 24h :
  - annulé il y a 23h → **visible** ;
  - annulé il y a 25h → **masqué** ;
  - `CANCELLED` sans `cancelledAt` → **masqué**.
- Achat multiple : commande de N billets → N entrées `tickets` distinctes.
- Deux commandes du même utilisateur pour le même événement → une seule entrée
  d'événement regroupant tous les billets.
- Réponse vide quand l'utilisateur n'a aucun billet.
- `posterUrl` / `ticketImageUrl` / `pdfUrl` à `null` gérés sans erreur.
