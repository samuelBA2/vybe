import { v2 as cloudinary } from 'cloudinary';

/**
 * Script one-shot de purge du dossier Cloudinary TICKETS.
 *
 * Utilisation : npx ts-node scripts/purge-ticket-assets.ts (en staging d'abord, puis prod)
 * NE PAS automatiser — exécution manuelle unique.
 *
 * Ce script supprime TOUTES les ressources sous le préfixe 'vybe/tickets'
 * (depuis CloudinaryFolder.TICKETS), pour les types 'image' et 'raw' (PDF).
 * La pagination est assurée via next_cursor jusqu'à épuisement.
 */

// Préfixe du dossier TICKETS (depuis src/cloudinary/cloudinary.folder.ts)
const PREFIX = 'vybe/tickets';

// Configuration Cloudinary depuis variables d'environnement
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Supprime les ressources du dossier TICKETS en boucle paginée.
 * Utilise delete_resources_by_prefix avec suivi de next_cursor.
 */
async function main(): Promise<void> {
  try {
    // Traiter chaque type de ressource (image pour PNG, raw pour PDF)
    for (const resourceType of ['image', 'raw'] as const) {
      console.log(`\n[${resourceType}] Démarrage de la purge...`);

      let nextCursor: string | undefined;
      let totalDeleted = 0;

      do {
        const response: any = await cloudinary.api.delete_resources_by_prefix(
          PREFIX,
          {
            resource_type: resourceType,
            next_cursor: nextCursor,
          },
        );

        const deletedCount = Object.keys(response.deleted ?? {}).length;
        totalDeleted += deletedCount;

        console.log(`  Batch supprimé : ${deletedCount} ressource(s)`);

        // Passer au batch suivant si next_cursor est présent
        nextCursor = response.next_cursor;
      } while (nextCursor);

      console.log(`[${resourceType}] Total supprimé : ${totalDeleted} ressource(s)`);
    }

    console.log('\n✓ Purge complète du dossier "vybe/tickets" terminée.');
    process.exit(0);
  } catch (error) {
    console.error('Erreur lors de la purge :', error);
    process.exit(1);
  }
}

main();
