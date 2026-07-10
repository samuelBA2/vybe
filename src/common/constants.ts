// Coût (nombre de rounds) bcrypt pour le hachage des mots de passe.
// Constante partagée : garantit un coût identique à l'inscription et au
// changement de mot de passe (évite toute divergence 10 vs 12).
export const BCRYPT_ROUNDS = 12;
