import { BadRequestException } from '@nestjs/common';
import type { ProviderOperator } from './payment-provider.interface';

// Le préfixe du numéro saisi doit correspondre à l'opérateur Mobile Money choisi.
// Contrôle 100% backend. Accepte 243XXXXXXXXX, 0XXXXXXXXX et XXXXXXXXX ; compare
// le début du numéro national aux préfixes déclarés par l'opérateur.
export function assertPhoneMatchesOperator(
  op: ProviderOperator,
  phoneNumber: string,
): void {
  if (!op.phonePrefixes?.length) return; // opérateur sans préfixes connus : pas de contrôle
  let national = phoneNumber;
  if (national.startsWith('243')) national = national.slice(3);
  else if (national.startsWith('0')) national = national.slice(1);
  if (!op.phonePrefixes.some((prefix) => national.startsWith(prefix))) {
    throw new BadRequestException('Champ mal rempli, resseyez');
  }
}
