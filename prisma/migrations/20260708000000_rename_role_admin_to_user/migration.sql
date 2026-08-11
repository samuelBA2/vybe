-- Renomme la valeur d'enum Role.ADMIN en Role.USER SANS perte de données.
-- ALTER TYPE ... RENAME VALUE conserve toutes les lignes existantes
-- (les User déjà en 'ADMIN' deviennent automatiquement 'USER').
ALTER TYPE "Role" RENAME VALUE 'ADMIN' TO 'USER';
