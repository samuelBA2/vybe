import { BadRequestException } from '@nestjs/common';
import type { ProviderOperator } from './payment-provider.interface';

// V4 : le numéro (243 + 9 chiffres) doit appartenir à l'opérateur choisi. Évite
// un push voué à l'échec (et opaque pour l'utilisateur) vers le mauvais réseau.
export function assertPhoneMatchesOperator(
  op: ProviderOperator,
  phoneNumber: string,
): void {
  if (!op.phonePrefixes?.length) return; // préfixes inconnus : pas de contrôle
  const national = phoneNumber.startsWith('243')
    ? phoneNumber.slice(3)
    : phoneNumber;
  if (!op.phonePrefixes.some((p) => national.startsWith(p))) {
    throw new BadRequestException(
      "Ce numéro ne correspond pas à l'opérateur choisi.",
    );
  }
}
