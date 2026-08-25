import { randomInt } from 'crypto';
import { ALPHABET } from './constants';

// Alphabet SANS caractères ambigus (pas de 0/O ni 1/I) : un code lisible,
// dictable au téléphone sans confusion. 32 caractères.

// Génère un code du type "VYBE-67XC6F".
// randomInt (crypto) tire un index uniforme dans [0, ALPHABET.length) :
// aléatoire non prédictible et SANS biais modulo (contrairement à Math.random
// ou à `byte % 32`). prefix = "VYBE"/"AG", length = nombre de caractères.
export function randomCode(prefix: string, length: number): string {
    let suffix = '';
    for (let i = 0; i < length; i++ ){
        suffix += ALPHABET[randomInt(ALPHABET.length)];
    }
    return `${prefix}-${suffix}`
}
